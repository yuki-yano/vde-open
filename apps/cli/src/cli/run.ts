import {
  errorEnvelope,
  ExitCode,
  exitCodeForError,
  isErrorCode,
  isVdeError,
  LIMITS,
  successEnvelope,
  VdeError,
  type CloseResult,
  type DaemonStatus,
  type DocumentSummary,
  type Envelope,
  type ErrorBody,
  type ListResult,
  type OpenResult,
  type ReadResult,
  type Warning,
} from '@vde-open/shared';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };
import { startDaemon } from '../daemon/main.ts';
import { runDoctor, type DoctorReport } from '../doctor/doctor.ts';
import type { PathEnvironment } from '../persistence/paths.ts';
import { normalizeArgv } from './argv.ts';
import { createDaemonControl, type DaemonControl } from './daemon-control.ts';
import { escapeContentForTerminal, escapeForTerminal, safeJson } from './output.ts';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliContext extends CliIo {
  cwd: string;
  environment: PathEnvironment;
  stdoutIsTty: boolean;
  stdin: {
    // shellのpipeまたはredirectでdataが渡されているか。
    isPiped: boolean;
    read: () => Promise<Buffer>;
  };
}

export const CLI_VERSION: string = packageJson.version;

// 表示名は呼び出し名（vde-open／vo）によらず固定する。両名の出力を一致させ、
// 呼び出し名からstateやdaemonの識別子を作らないため。
const PROGRAM_NAME = 'vde-open';

interface CommandOutcome<T> {
  data: T;
  catalogVersion?: number;
  warnings?: Warning[];
}

function toErrorBody(error: unknown): ErrorBody {
  if (isVdeError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  return {
    code: 'E_INTERNAL',
    message: '内部errorが発生しました。',
    retryable: false,
    details: {},
  };
}

function unwrap<T>(envelope: Envelope<T>): CommandOutcome<T> {
  if (!envelope.ok) {
    const { code, message, details, retryable } = envelope.error;
    throw new VdeError(isErrorCode(code) ? code : 'E_INTERNAL', message, details, { retryable });
  }
  const outcome: CommandOutcome<T> = { data: envelope.data, warnings: envelope.warnings };
  if (envelope.meta.catalogVersion !== undefined)
    outcome.catalogVersion = envelope.meta.catalogVersion;
  return outcome;
}

function parseInteger(label: string, min: number, max: number) {
  return (value: string): number => {
    if (!/^\d+$/.test(value)) throw new InvalidArgumentError(`${label}は整数で指定してください。`);
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
      throw new InvalidArgumentError(
        `${label}は${String(min)}〜${String(max)}で指定してください。`,
      );
    }
    return parsed;
  };
}

function parseLines(value: string): { start: number; end: number } {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new InvalidArgumentError('--linesはA:Bの形で指定してください。');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end < start) {
    throw new InvalidArgumentError('--linesは1以上で、A<=Bになるように指定してください。');
  }
  return { start, end };
}

function parseFormat(value: string): 'auto' | 'markdown' | 'html' {
  if (value === 'auto' || value === 'markdown' || value === 'html') return value;
  throw new InvalidArgumentError('--formatはauto、markdown、htmlのいずれかです。');
}

function describeDocument(document: DocumentSummary): string {
  const path = document.displayPath ?? `(${document.sourceKind})`;
  return `${document.documentId}  ${escapeForTerminal(document.title)}  ${escapeForTerminal(path)}`;
}

export async function runCli(rawArgv: string[], context: CliContext): Promise<ExitCode> {
  const wantsJson = rawArgv.includes('--json');
  const control: DaemonControl = createDaemonControl(context.environment);
  let exitCode: ExitCode = ExitCode.success;

  const fail = (error: unknown, json: boolean) => {
    const body = toErrorBody(error);
    exitCode = exitCodeForError(body.code);
    if (json) context.stdout(`${safeJson(errorEnvelope(body))}\n`);
    else context.stderr(`${escapeForTerminal(`${body.code}: ${body.message}`)}\n`);
    if (!isVdeError(error) && error instanceof Error) {
      context.stderr(`${escapeForTerminal(error.message)}\n`);
    }
  };

  // 各commandの共通処理。JSONならenvelopeを1個だけstdoutへ出す（仕様5.6）。
  const execute = async <T>(
    command: string,
    json: boolean,
    work: () => Promise<CommandOutcome<T>>,
    render: (data: T) => string,
  ): Promise<void> => {
    try {
      const outcome = await work();
      const warnings = outcome.warnings ?? [];
      if (json) {
        const meta =
          outcome.catalogVersion === undefined
            ? { command }
            : { command, catalogVersion: outcome.catalogVersion };
        context.stdout(`${safeJson(successEnvelope(outcome.data, meta, warnings))}\n`);
      } else {
        for (const warning of warnings) {
          context.stderr(`${escapeForTerminal(`${warning.code}: ${warning.message}`)}\n`);
        }
        const text = render(outcome.data);
        if (text !== '') context.stdout(text.endsWith('\n') ? text : `${text}\n`);
      }
    } catch (error) {
      fail(error, json);
    }
  };

  const viaDaemon = async <T>(method: string, params: unknown): Promise<CommandOutcome<T>> => {
    const connection = await control.ensure();
    try {
      return unwrap(await connection.request<T>(method, params));
    } finally {
      connection.close();
    }
  };

  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(
      '開いたMarkdown／HTMLをブラウザで表示し、Agentが一覧・検索・部分取得できるようにするローカルCLI',
    )
    .version(CLI_VERSION, '-V, --version', 'versionを表示する')
    .helpOption('-h, --help', 'helpを表示する')
    .addHelpText(
      'after',
      '\n`vo`は`vde-open`と同じコマンドです。fileを直接渡すと`open`として扱います（例: vo a.md）。',
    )
    .exitOverride()
    .configureOutput({ writeOut: context.stdout, writeErr: context.stderr })
    .action(() => {
      context.stdout(program.helpInformation());
    });

  const openCommand = program.command('open');
  openCommand
    .description('文書を開く。directoryやglobは、対象の文書を列挙して開く')
    .argument('[paths...]', 'file、directory、glob。`-`はstdin')
    .option('--format <format>', 'auto、markdown、html。stdinでは必須', parseFormat, 'auto')
    .option('--title <text>', '表示するtitle。1文書のときだけ')
    .option('--key <key>', 'stdinの文書を同じ1件として更新するためのkey。1文書のときだけ')
    .option('-R, --recursive', 'directoryを再帰的に列挙する', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (paths: string[], options: OpenOptions) => {
      await execute<OpenResult>(
        'open',
        options.json,
        async () => {
          const explicitStdin = paths.includes('-');
          const filePaths = paths.filter((path) => path !== '-');
          const fromStdin = explicitStdin || (filePaths.length === 0 && context.stdin.isPiped);
          if (fromStdin && filePaths.length > 0) {
            throw new VdeError('E_INVALID_ARGUMENT', 'stdinとpathは同時に指定できません。');
          }
          // pipeで内容が渡されているのにpathもある場合、どちらを開くのか決められない。
          if (!fromStdin && context.stdin.isPiped) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              'stdinとpathは同時に指定できません。pathを開くときは、stdinへ内容を渡さないでください。',
            );
          }
          const base = {
            cwd: context.cwd,
            format: options.format,
            recursive: options.recursive,
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.key === undefined ? {} : { key: options.key }),
          };
          if (!fromStdin) return viaDaemon('documents.open', { ...base, paths: filePaths });
          if (options.format === 'auto') {
            throw new VdeError('E_INVALID_ARGUMENT', 'stdinから開くときは--formatが必要です。');
          }
          // EOFまで読み切ってから登録する。途中の内容を完成した文書として扱わない。
          const bytes = await context.stdin.read();
          return viaDaemon('documents.open', {
            ...base,
            paths: [],
            stdin: { content: decodeStdin(bytes) },
          });
        },
        (data) =>
          [
            ...data.documents.map(describeDocument),
            `${String(data.documents.length)}件（新規 ${String(data.created)}、更新 ${String(data.updated)}、変更なし ${String(data.unchanged)}）`,
          ].join('\n'),
      );
    });

  program
    .command('list')
    .description('開いている文書を一覧する')
    .option(
      '--limit <n>',
      `件数（既定${String(LIMITS.listLimitDefault)}、最大${String(LIMITS.listLimitMax)}）`,
      parseInteger('--limit', 1, LIMITS.listLimitMax),
    )
    .option('--cursor <cursor>', '前回の結果のnextCursor')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { limit?: number; cursor?: string; json: boolean }) => {
      await execute<ListResult>(
        'list',
        options.json,
        () =>
          viaDaemon('documents.list', {
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          }),
        (data) =>
          [
            ...data.documents.map(describeDocument),
            `${String(data.documents.length)}件／開いている文書 ${String(data.totalDocuments)}件`,
          ].join('\n'),
      );
    });

  program
    .command('read')
    .description('開いている文書の原文を取得する')
    .argument('<documentId>', '文書ID')
    .option('--lines <A:B>', '原文の行範囲（1始まり、両端を含む）', parseLines)
    .option('--revision <revision>', '取得する版。保持されていなければerror')
    .option(
      '--max-bytes <n>',
      `本文の上限byte数（既定${String(LIMITS.readMaxBytesDefault)}）`,
      parseInteger('--max-bytes', 1, Number.MAX_SAFE_INTEGER),
    )
    .option('--cursor <cursor>', '前回の結果のnextCursor')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (documentId: string, options: ReadOptions) => {
      await execute<ReadResult>(
        'read',
        options.json,
        () => {
          if (
            options.maxBytes !== undefined &&
            (options.maxBytes < LIMITS.readMaxBytesMin || options.maxBytes > LIMITS.readMaxBytesMax)
          ) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              `--max-bytesは${String(LIMITS.readMaxBytesMin)}〜${String(LIMITS.readMaxBytesMax)}で指定してください。`,
              { min: LIMITS.readMaxBytesMin, max: LIMITS.readMaxBytesMax },
            );
          }
          return viaDaemon('documents.read', {
            documentId,
            ...(options.lines === undefined ? {} : { lines: options.lines }),
            ...(options.revision === undefined ? {} : { revision: options.revision }),
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          });
        },
        (data) => (context.stdoutIsTty ? escapeContentForTerminal(data.content) : data.content),
      );
    });

  program
    .command('close')
    .description('文書を一覧から外す。原本は削除しない')
    .argument('[targets...]', '文書IDまたはpath')
    .option('--all', '開いている文書をすべて閉じる', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (targets: string[], options: { all: boolean; json: boolean }) => {
      await execute<CloseResult>(
        'close',
        options.json,
        () => viaDaemon('documents.close', { cwd: context.cwd, targets, all: options.all }),
        (data) =>
          `${String(data.closed.length)}件を閉じました（すでに閉じていた文書 ${String(data.alreadyClosed.length)}件）`,
      );
    });

  const renderStatus = (status: DaemonStatus) =>
    status.state === 'running'
      ? `running  pid=${String(status.pid)}  開いている文書 ${String(status.openDocuments)}件`
      : 'stopped';

  const daemon = program.command('daemon').description('daemonを起動・確認・停止する');
  daemon
    .command('status')
    .description('daemonの状態を表示する。停止中でも新しく起動しない')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { json: boolean }) => {
      await execute<DaemonStatus>(
        'daemon.status',
        options.json,
        async () => {
          const connection = await control.connectExisting();
          if (!connection) return { data: control.stoppedStatus() };
          try {
            return unwrap(await connection.request<DaemonStatus>('daemon.status', {}));
          } finally {
            connection.close();
          }
        },
        renderStatus,
      );
    });
  daemon
    .command('start')
    .description('daemonを起動する。起動済みならそのまま使う')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { json: boolean }) => {
      await execute<DaemonStatus>(
        'daemon.start',
        options.json,
        () => viaDaemon('daemon.status', {}),
        renderStatus,
      );
    });
  daemon
    .command('stop')
    .description('daemonを停止する。開いている文書の登録は残る')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { json: boolean }) => {
      await execute<{ state: 'stopped'; wasRunning: boolean }>(
        'daemon.stop',
        options.json,
        async () => ({ data: { state: 'stopped', ...(await control.stop()) } }),
        (data) => (data.wasRunning ? '停止しました' : '起動していません'),
      );
    });
  daemon
    .command('restart')
    .description('daemonを停止してから起動する')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { json: boolean }) => {
      await execute<DaemonStatus>(
        'daemon.restart',
        options.json,
        async () => {
          await control.stop();
          return viaDaemon('daemon.status', {});
        },
        renderStatus,
      );
    });

  program
    .command('serve')
    .description('daemonを前景で動かす。Ctrl+Cで停止する')
    .action(async () => {
      try {
        const handle = await startDaemon({
          environment: context.environment,
          version: CLI_VERSION,
        });
        context.stderr(
          `daemonを前景で起動しました（pid=${String(process.pid)}）。Ctrl+Cで停止します。\n`,
        );
        const onSignal = () => void handle.stop('signal');
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        await handle.stopped;
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      } catch (error) {
        fail(error, false);
      }
    });

  program
    .command('doctor')
    .description('stateとdaemonの状態を診断する')
    .option('--repair', '検証済みのbackupからの回復と、停止済みdaemonのruntime回収を行う', false)
    .option('--yes', '--repairの実行を確認済みとする', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { repair: boolean; yes: boolean; json: boolean }) => {
      await execute<DoctorReport>(
        'doctor',
        options.json,
        async () => {
          if (options.repair && !options.yes) {
            throw new VdeError(
              'E_CONFIRMATION_REQUIRED',
              '--repairはstateを書き換えることがあります。実行するには--yesを付けてください。',
            );
          }
          const result = await runDoctor({
            environment: context.environment,
            control,
            version: CLI_VERSION,
            repair: options.repair,
          });
          return { data: result.report, warnings: result.warnings };
        },
        (report) =>
          [
            `state root: ${escapeForTerminal(report.stateRoot.path)}`,
            `state: ${report.state.status}`,
            `backup: ${report.previousState.status}`,
            `daemon: ${report.daemon.reachable ? 'running' : 'stopped'}（lock: ${report.daemon.lock}）`,
            ...report.problems.map((problem) => `問題: ${problem.code} ${problem.message}`),
            ...report.repairs.map((repair) => `修復: ${repair}`),
            report.problems.length === 0 ? '問題は見つかりませんでした。' : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
      );
    });

  // subcommandの一覧と、値を取るopenのoptionを、commandの定義から取る。
  const valueOptions = new Set<string>();
  for (const option of openCommand.options) {
    if (!option.required && !option.optional) continue;
    if (option.short) valueOptions.add(option.short);
    if (option.long) valueOptions.add(option.long);
  }
  const argv = normalizeArgv(rawArgv, context.stdin.isPiped, {
    subcommands: new Set([...program.commands.map((command) => command.name()), 'help']),
    valueOptions,
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return ExitCode.success;
      // 引数のerror。commanderの説明はstderrへ出ている。JSONならenvelopeも返す。
      if (wantsJson) {
        context.stdout(
          `${safeJson(
            errorEnvelope({
              code: 'E_INVALID_ARGUMENT',
              message: error.message,
              retryable: false,
              details: { reason: error.code },
            }),
          )}\n`,
        );
      }
      return ExitCode.usage;
    }
    throw error;
  }
  return exitCode;
}

interface OpenOptions {
  format: 'auto' | 'markdown' | 'html';
  title?: string;
  key?: string;
  recursive: boolean;
  json: boolean;
}

interface ReadOptions {
  lines?: { start: number; end: number };
  revision?: string;
  maxBytes?: number;
  cursor?: string;
  json: boolean;
}

function decodeStdin(bytes: Buffer): string {
  if (bytes.byteLength > LIMITS.documentBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', 'stdinの内容が1文書の大きさの上限を超えています。', {
      limit: 'documentBytes',
      max: LIMITS.documentBytes,
      actual: bytes.byteLength,
    });
  }
  if (bytes.includes(0)) {
    throw new VdeError('E_INVALID_SOURCE', 'stdinの内容は開けません（contains-nul）。', {
      path: 'stdin',
      reason: 'contains-nul',
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new VdeError('E_INVALID_SOURCE', 'stdinの内容は開けません（invalid-utf8）。', {
      path: 'stdin',
      reason: 'invalid-utf8',
    });
  }
}
