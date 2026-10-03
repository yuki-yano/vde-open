import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  errorEnvelope,
  ExitCode,
  exitCodeForError,
  isErrorCode,
  isVdeError,
  LIMITS,
  successEnvelope,
  VdeError,
  type BootstrapResult,
  type CloseResult,
  type DaemonStatus,
  type DocumentSummary,
  type Envelope,
  type ErrorBody,
  type FeedbackCreateResult,
  type FeedbackForAgent,
  type FeedbackListResult,
  type ListResult,
  type OpenResult,
  type ReadResult,
  type RefreshResult,
  type SearchResult,
  type Warning,
  type WatchListResult,
} from '@vde-open/shared';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };
import { startDaemon } from '../daemon/main.ts';
import { runDoctor, type DoctorReport } from '../doctor/doctor.ts';
import type { PathEnvironment } from '../persistence/paths.ts';
import type { IpcConnection } from '../server/ipc-client.ts';
import { normalizeArgv } from './argv.ts';
import { createBrowserLauncher } from './browser.ts';
import { createDaemonControl, type DaemonControl } from './daemon-control.ts';
import { escapeContentForTerminal, escapeForTerminal, safeJson } from './output.ts';
import { waitForAnswer } from './wait-for-answer.ts';

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

interface UiResult {
  uiUrl: string;
  opened: boolean;
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
  if (envelope.meta.catalogVersion !== undefined) {
    outcome.catalogVersion = envelope.meta.catalogVersion;
  }
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

function parseHtmlMode(value: string): 'static' | 'interactive' {
  if (value === 'static' || value === 'interactive') return value;
  throw new InvalidArgumentError('--html-modeはstaticかinteractiveを指定してください。');
}

function describeDocument(document: DocumentSummary): string {
  const path = document.displayPath ?? `(${document.sourceKind})`;
  return `${document.documentId}  ${escapeForTerminal(document.title)}  ${escapeForTerminal(path)}`;
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

interface OpenOptions {
  format: 'auto' | 'markdown' | 'html';
  title?: string;
  key?: string;
  recursive: boolean;
  watch: boolean;
  htmlMode?: 'static' | 'interactive';
  assetsRoot?: string;
  asset: string[];
  open?: boolean;
  focus: boolean;
  json: boolean;
}

interface SearchOptions {
  mode?: 'text' | 'exact' | 'path';
  limit?: number;
  document: string[];
  maxBytes?: number;
  cursor?: string;
  json: boolean;
}

interface AskOptions {
  document?: string;
  revision?: string;
  view?: string;
  htmlMode?: 'static' | 'interactive';
  assetsRoot?: string;
  asset: string[];
  operationId?: string;
  open?: boolean;
  focus: boolean;
  json: boolean;
}

function parseFeedbackStatus(value: string): 'pending' | 'submitted' | 'cancelled' {
  if (value === 'pending' || value === 'submitted' || value === 'cancelled') return value;
  throw new InvalidArgumentError('--statusはpending、submitted、cancelledのいずれかです。');
}

function describeRequest(request: FeedbackForAgent): string {
  return `${request.requestId}  ${request.status}  ${escapeForTerminal(request.title)}  ${request.documentId}`;
}

// 回答を表示する。値は利用者が入力した内容なので、端末の制御文字を無害にする。
function describeAnswers(request: FeedbackForAgent): string {
  const lines = [describeRequest(request)];
  if (request.submission) {
    lines.push(`回答 ${request.submission.submissionId}（${request.submission.submittedAt}）`);
    for (const [name, value] of Object.entries(request.submission.answers)) {
      lines.push(
        `  ${escapeForTerminal(name)}: ${escapeContentForTerminal(JSON.stringify(value))}`,
      );
    }
    if (request.submission.confirmedAgainstOlderRevision) {
      lines.push('  （新しい版があることを確認したうえで、質問の版に対して回答されました）');
    }
  }
  if (request.cancellation) lines.push(`中止: ${request.cancellation.reason}`);
  if (request.acknowledgedAt) lines.push(`取得済み: ${request.acknowledgedAt}`);
  return lines.join('\n');
}

// 質問定義のfileを読む。大きさは読む前に確かめる。内容の検証はdaemonが行う。
async function readQuestionnaire(cwd: string, path: string): Promise<string> {
  const absolute = resolve(cwd, path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('not-file');
    size = info.size;
  } catch {
    throw new VdeError('E_PATH_NOT_FOUND', '質問定義のfileを読めません。', { path });
  }
  if (size > LIMITS.questionnaireBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', '質問定義が大きすぎます。', {
      limit: 'questionnaireBytes',
      max: LIMITS.questionnaireBytes,
      actual: size,
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await readFile(absolute),
    );
  } catch {
    throw new VdeError('E_QUESTIONNAIRE_INVALID', '質問定義をUTF-8として読めません。', { path });
  }
}

function parseSearchMode(value: string): 'text' | 'exact' | 'path' {
  if (value === 'text' || value === 'exact' || value === 'path') return value;
  throw new InvalidArgumentError('--modeはtext、exact、pathのいずれかです。');
}

interface ReadOptions {
  section?: string;
  lines?: { start: number; end: number };
  revision?: string;
  maxBytes?: number;
  cursor?: string;
  outline: boolean;
  json: boolean;
}

export async function runCli(rawArgv: string[], context: CliContext): Promise<ExitCode> {
  const wantsJson = rawArgv.includes('--json');
  const control: DaemonControl = createDaemonControl(context.environment);
  const browser = createBrowserLauncher(context.environment.env, context.environment.platform);
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

  // browserで管理UIを開く。開けなかったら、登録などの結果とは別にwarningとして伝える。
  const openBrowser = async (connection: IpcConnection): Promise<Warning[]> => {
    const { data } = unwrap(await connection.request<BootstrapResult>('ui.bootstrap', {}));
    if (await browser.open(data.bootstrapUrl)) return [];
    return [
      {
        code: 'W_BROWSER_OPEN_FAILED',
        message:
          'browserを開けませんでした。`vde-open ui --print-url`で表示したURLを、browserで開いてください。',
        details: { uiUrl: data.uiUrl },
      },
    ];
  };

  const showUi = async (printUrl: boolean): Promise<CommandOutcome<UiResult>> => {
    const connection = await control.ensure();
    try {
      if (printUrl) {
        const { data } = unwrap(await connection.request<BootstrapResult>('ui.bootstrap', {}));
        // 秘密を含むURL。通常の結果（JSON）には混ぜず、明示されたときだけ出す。
        context.stderr('次のURLは60秒間・1回だけ有効な秘密を含みます。共有しないでください。\n');
        context.stdout(`${data.bootstrapUrl}\n`);
        return { data: { uiUrl: data.uiUrl, opened: false } };
      }
      const status = unwrap(await connection.request<DaemonStatus>('daemon.status', {})).data;
      const warnings = await openBrowser(connection);
      return { data: { uiUrl: status.uiUrl ?? '', opened: warnings.length === 0 }, warnings };
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
      '\n`vo`は`vde-open`と同じコマンドです。fileを直接渡すと`open`として扱います（例: vo a.md）。\n引数なしで実行すると、管理UIをbrowserで開きます。',
    )
    .exitOverride()
    .configureOutput({ writeOut: context.stdout, writeErr: context.stderr })
    // 引数なしは`ui`と同じ（仕様5.1）。
    .action(async () => {
      await execute<UiResult>(
        'ui',
        false,
        () => showUi(false),
        () => '',
      );
    });

  const openCommand = program.command('open');
  // parserがoptionとして認識した指定だけを数える。`--`より後のfile名やoptionの値は数えない。
  const seenOpenFlags = new Set<'open' | 'no-open'>();
  openCommand.on('option:open', () => seenOpenFlags.add('open'));
  openCommand.on('option:no-open', () => seenOpenFlags.add('no-open'));
  openCommand
    .description('文書を開く。directoryやglobは、対象の文書を列挙して開く')
    .argument('[paths...]', 'file、directory、glob。`-`はstdin')
    .option('--format <format>', 'auto、markdown、html。stdinでは必須', parseFormat, 'auto')
    .option('--title <text>', '表示するtitle。1文書のときだけ')
    .option('--key <key>', 'stdinの文書を同じ1件として更新するためのkey。1文書のときだけ')
    .option('-R, --recursive', 'directoryを再帰的に列挙する', false)
    .option('-w, --watch', 'directory／globに新しく現れた文書も開く', false)
    .option(
      '--html-mode <mode>',
      'HTMLの表示方法。static（既定。scriptを動かさない）、interactive（scriptを動かすことを許可する）',
      parseHtmlMode,
    )
    .option(
      '--assets-root <dir>',
      '画像やCSSなどのlocal fileを読める範囲。指定がなければ、文書のあるdirectory',
    )
    .option(
      '--asset <path>',
      '文書の解析では見つからないlocal fileを個別に登録する（assets-rootからの相対path）。複数回指定できる',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--open', 'browserで管理UIを開く')
    .option('--no-open', 'browserを開かない')
    .option('--focus', '最初に指定した文書を表示中の文書にする', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (paths: string[], options: OpenOptions) => {
      await execute<OpenResult>(
        'open',
        options.json,
        async () => {
          if (seenOpenFlags.size === 2) {
            throw new VdeError('E_INVALID_ARGUMENT', '--openと--no-openは同時に指定できません。');
          }
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
            watch: options.watch,
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.key === undefined ? {} : { key: options.key }),
            ...(options.htmlMode === undefined ? {} : { htmlMode: options.htmlMode }),
            ...(options.assetsRoot === undefined ? {} : { assetsRoot: options.assetsRoot }),
            assets: options.asset,
          };
          let params: Record<string, unknown>;
          if (fromStdin) {
            if (options.format === 'auto') {
              throw new VdeError('E_INVALID_ARGUMENT', 'stdinから開くときは--formatが必要です。');
            }
            // EOFまで読み切ってから登録する。途中の内容を完成した文書として扱わない。
            params = {
              ...base,
              paths: [],
              stdin: { content: decodeStdin(await context.stdin.read()) },
            };
          } else {
            params = { ...base, paths: filePaths };
          }

          const { connection, started } = await control.ensureDetailed();
          try {
            const outcome = unwrap(await connection.request<OpenResult>('documents.open', params));
            const warnings = [...(outcome.warnings ?? [])];
            const first = outcome.data.documents[0];
            if (options.focus && first) {
              await connection.request('documents.focus', { documentId: first.documentId });
            }
            // 開く・browserを開く・focusするは、それぞれ独立した操作（仕様5.2）。
            // 指定がなければ、端末からの実行で、daemonを新しく起動したときだけbrowserを開く。
            const shouldOpen = options.open ?? (!options.json && context.stdoutIsTty && started);
            if (shouldOpen) warnings.push(...(await openBrowser(connection)));
            return { ...outcome, warnings };
          } finally {
            connection.close();
          }
        },
        (data) =>
          [
            ...data.documents.map(describeDocument),
            ...data.watchRules.map(
              (rule) => `監視: ${rule.watchId}  ${escapeForTerminal(rule.pattern ?? rule.root)}`,
            ),
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
    .command('search')
    .description('開いている文書を検索する。対象は、開いている文書だけ')
    .argument('<query>', '検索する語。文字として扱い、正規表現としては解釈しない')
    .option(
      '--mode <mode>',
      'text（語の一致。既定）、exact（連続した文字列だけ）、path（file名とpathだけ）',
      parseSearchMode,
    )
    .option(
      '--limit <n>',
      `件数（既定${String(LIMITS.searchLimitDefault)}、最大${String(LIMITS.searchLimitMax)}）`,
      parseInteger('--limit', 1, LIMITS.searchLimitMax),
    )
    .option(
      '--document <documentId>',
      '対象を絞る文書ID。複数回指定できる',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--max-bytes <n>',
      `結果の上限byte数（既定${String(LIMITS.readMaxBytesDefault)}）`,
      parseInteger('--max-bytes', 1, Number.MAX_SAFE_INTEGER),
    )
    .option('--cursor <cursor>', '前回の結果のnextCursor')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (query: string, options: SearchOptions) => {
      await execute<SearchResult>(
        'search',
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
          return viaDaemon('documents.search', {
            query,
            documents: options.document,
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          });
        },
        (data) =>
          [
            ...data.hits.map(
              (hit) =>
                `${hit.documentId}  ${hit.sectionId}  ${escapeForTerminal(hit.title)}${hit.headingPath.length > 0 ? `  ＞ ${escapeForTerminal(hit.headingPath.join(' ＞ '))}` : ''}\n    ${escapeForTerminal(hit.excerpt)}`,
            ),
            `${String(data.hits.length)}件／検索した文書 ${String(data.searchedDocuments)}件（開いている文書 ${String(data.registeredDocuments)}件）${data.truncated ? '　続きがあります' : ''}`,
            ...(data.incomplete
              ? [
                  `一部の文書は検索できていません（準備中 ${String(data.indexingDocuments.length)}件、失敗 ${String(data.failedDocuments.length)}件）`,
                ]
              : []),
          ].join('\n'),
      );
    });

  program
    .command('read')
    .description('開いている文書の原文、見出しの構造、または1つの節の本文を取得する')
    .argument('<documentId>', '文書ID')
    .option('--outline', '見出しの構造を取得する', false)
    .option('--section <sectionId>', '1つの節の、抽出した本文を取得する（例: sec_0002）')
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
          const selectors = [
            options.outline,
            options.section !== undefined,
            options.lines !== undefined,
          ].filter(Boolean).length;
          if (selectors > 1) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              '--outline、--section、--linesは、どれか1つだけ指定できます。',
            );
          }
          // cursorは、発行したときの版と取得の種類で続きを取る。範囲や版は変えられない。
          if (options.cursor !== undefined && (selectors > 0 || options.revision !== undefined)) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              '--cursorと、--revision・--outline・--section・--linesは併用できません。',
            );
          }
          return viaDaemon('documents.read', {
            documentId,
            outline: options.outline,
            ...(options.section === undefined ? {} : { section: options.section }),
            ...(options.lines === undefined ? {} : { lines: options.lines }),
            ...(options.revision === undefined ? {} : { revision: options.revision }),
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          });
        },
        (data) => {
          if (data.outline) {
            return data.outline
              .map(
                (item) =>
                  `${'  '.repeat(item.level - 1)}${escapeForTerminal(item.title)}  (${item.sectionId})`,
              )
              .join('\n');
          }
          const content = data.content ?? '';
          return context.stdoutIsTty ? escapeContentForTerminal(content) : content;
        },
      );
    });

  program
    .command('close')
    .description('文書を一覧から外す。原本は削除しない')
    .argument('[targets...]', '文書IDまたはpath')
    .option('--all', '開いている文書をすべて閉じ、監視ruleも解除する', false)
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

  program
    .command('focus')
    .description('管理UIで表示する文書を切り替える')
    .argument('<documentId>', '文書ID')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (documentId: string, options: { json: boolean }) => {
      await execute<{ documentId: string }>(
        'focus',
        options.json,
        () => viaDaemon('documents.focus', { documentId }),
        (data) => `表示する文書を切り替えました: ${data.documentId}`,
      );
    });

  program
    .command('refresh')
    .description('fileを読み直す。指定がなければ、開いているfileのすべて')
    .argument('[documentId]', '文書ID')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (documentId: string | undefined, options: { json: boolean }) => {
      await execute<RefreshResult>(
        'refresh',
        options.json,
        () => viaDaemon('documents.refresh', documentId === undefined ? {} : { documentId }),
        (data) =>
          `${String(data.documents.length)}件を確認し、${String(data.changed.length)}件を更新しました`,
      );
    });

  const renderRules = (data: WatchListResult) =>
    data.watchRules.length === 0
      ? '監視ruleはありません'
      : data.watchRules
          .map(
            (rule) =>
              `${rule.watchId}  ${rule.kind}  ${escapeForTerminal(rule.pattern ?? rule.root)}${rule.recursive ? '  (再帰)' : ''}`,
          )
          .join('\n');

  const askCommand = program.command('ask');
  const seenAskFlags = new Set<'open' | 'no-open'>();
  askCommand.on('option:open', () => seenAskFlags.add('open'));
  askCommand.on('option:no-open', () => seenAskFlags.add('no-open'));
  askCommand
    .description(
      '人に質問する。回答は管理UIで入力・送信され、`feedback wait`で受け取る。秘密（password・API key）の入力には使わない',
    )
    .argument('<questionnaire>', '質問定義のJSON file')
    .option('--document <documentId>', '開いている文書へ質問する')
    .option('--revision <revision>', '--documentの、質問する版。指定がなければ現在の版')
    .option('--view <path>', '文書を開いてから、その版へ質問する')
    .option(
      '--html-mode <mode>',
      '--viewで開くHTMLの表示方法。interactiveなら、HTMLから回答案を送れる',
      parseHtmlMode,
    )
    .option('--assets-root <dir>', '--viewで開く文書の、local fileを読める範囲')
    .option(
      '--asset <path>',
      '--viewで開く文書の、個別に登録するlocal file（複数回指定できる）',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--operation-id <uuid>', '再試行で同じ質問を重ねて作らないための識別子')
    .option('--open', 'browserで管理UIを開く')
    .option('--no-open', 'browserを開かない')
    .option('--focus', '質問した文書を表示中の文書にする', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (questionnaire: string, options: AskOptions) => {
      await execute<FeedbackCreateResult>(
        'ask',
        options.json,
        async () => {
          if (seenAskFlags.size === 2) {
            throw new VdeError('E_INVALID_ARGUMENT', '--openと--no-openは同時に指定できません。');
          }
          const params = {
            cwd: context.cwd,
            questionnaire: await readQuestionnaire(context.cwd, questionnaire),
            ...(options.document === undefined ? {} : { documentId: options.document }),
            ...(options.revision === undefined ? {} : { revision: options.revision }),
            ...(options.view === undefined ? {} : { view: options.view }),
            ...(options.htmlMode === undefined ? {} : { htmlMode: options.htmlMode }),
            ...(options.assetsRoot === undefined ? {} : { assetsRoot: options.assetsRoot }),
            assets: options.asset,
            ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
          };
          const { connection, started } = await control.ensureDetailed();
          try {
            const outcome = unwrap(
              await connection.request<FeedbackCreateResult>('feedback.create', params),
            );
            const warnings = [...(outcome.warnings ?? [])];
            if (options.focus) {
              await connection.request('documents.focus', {
                documentId: outcome.data.request.documentId,
              });
            }
            const shouldOpen = options.open ?? (!options.json && context.stdoutIsTty && started);
            if (shouldOpen) warnings.push(...(await openBrowser(connection)));
            return { ...outcome, warnings };
          } finally {
            connection.close();
          }
        },
        (data) =>
          `${describeRequest(data.request)}${data.replayed ? '\n（同じoperation IDの質問を返しました）' : ''}`,
      );
    });

  // 回答を待つ。daemonが止まったり再起動したりしても、最初に決めた期限まで接続し直して待つ。
  // 期限を過ぎても、中断しても、質問は回答待ちのまま（仕様11.3）。
  const feedbackCommand = program
    .command('feedback')
    .description('質問の状態と回答を確認する。回答案（送信前の入力）は返さない');
  feedbackCommand
    .command('list')
    .description('質問を一覧する')
    .option('--status <status>', 'pending、submitted、cancelled', parseFeedbackStatus)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { status?: string; json: boolean }) => {
      await execute<FeedbackListResult>(
        'feedback.list',
        options.json,
        () =>
          viaDaemon(
            'feedback.list',
            options.status === undefined ? {} : { status: options.status },
          ),
        (data) =>
          [...data.requests.map(describeRequest), `${String(data.requests.length)}件`].join('\n'),
      );
    });
  feedbackCommand
    .command('get')
    .description('質問の状態と、確定した回答を取得する。取得済みの印は付けない')
    .argument('<requestId>', '質問のID')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (requestId: string, options: { json: boolean }) => {
      await execute<FeedbackForAgent>(
        'feedback.get',
        options.json,
        () => viaDaemon('feedback.get', { requestId }),
        describeAnswers,
      );
    });
  feedbackCommand
    .command('wait')
    .description('回答が確定するか、中止されるまで待つ。期限を過ぎても、質問は回答待ちのまま')
    .argument('<requestId>', '質問のID')
    .option(
      '--timeout <seconds>',
      `待つ秒数（既定${String(LIMITS.feedbackWaitDefaultSeconds)}、最大${String(LIMITS.feedbackWaitMaxSeconds)}）`,
      parseInteger('--timeout', 1, LIMITS.feedbackWaitMaxSeconds),
      LIMITS.feedbackWaitDefaultSeconds,
    )
    .option('--json', '結果をJSONで出力する', false)
    .action(async (requestId: string, options: { timeout: number; json: boolean }) => {
      await execute<FeedbackForAgent>(
        'feedback.wait',
        options.json,
        async () =>
          unwrap(
            await waitForAnswer({
              requestId,
              timeoutMs: options.timeout * 1000,
              connect: (signal) => control.ensure({ signal }),
              subscribeInterrupt: (listener) => {
                process.on('SIGINT', listener);
                return () => process.off('SIGINT', listener);
              },
            }),
          ),
        describeAnswers,
      );
    });
  feedbackCommand
    .command('ack')
    .description('確定した回答を取得・処理したことを記録する。何度実行しても同じ結果')
    .argument('<requestId>', '質問のID')
    .requiredOption('--submission-id <submissionId>', '回答のID（getやwaitの結果）')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (requestId: string, options: { submissionId: string; json: boolean }) => {
      await execute<FeedbackForAgent>(
        'feedback.ack',
        options.json,
        () => viaDaemon('feedback.ack', { requestId, submissionId: options.submissionId }),
        describeAnswers,
      );
    });
  feedbackCommand
    .command('cancel')
    .description('回答待ちの質問を中止する')
    .argument('<requestId>', '質問のID')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (requestId: string, options: { json: boolean }) => {
      await execute<FeedbackForAgent>(
        'feedback.cancel',
        options.json,
        () => viaDaemon('feedback.cancel', { requestId }),
        describeAnswers,
      );
    });
  feedbackCommand
    .command('forget')
    .description('終わった質問の記録を消す。回答待ちの質問は消せない。原本と文書は消さない')
    .argument('<requestId>', '質問のID')
    .option('--yes', '消すことを確認する', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (requestId: string, options: { yes: boolean; json: boolean }) => {
      await execute<{ requestId: string; forgotten: boolean }>(
        'feedback.forget',
        options.json,
        () => viaDaemon('feedback.forget', { requestId, confirmed: options.yes }),
        (data) => `${data.requestId}  消しました`,
      );
    });

  const watchCommand = program.command('watch').description('監視ruleを確認・解除する');
  watchCommand
    .command('list')
    .description('監視ruleを一覧する')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { json: boolean }) => {
      await execute<WatchListResult>(
        'watch.list',
        options.json,
        () => viaDaemon('watch.list', {}),
        renderRules,
      );
    });
  watchCommand
    .command('remove')
    .description('監視ruleを解除する。開いている文書は閉じない')
    .argument('<watchId>', '監視ruleのID')
    .option('--json', '結果をJSONで出力する', false)
    .action(async (watchId: string, options: { json: boolean }) => {
      await execute<WatchListResult>(
        'watch.remove',
        options.json,
        () => viaDaemon('watch.remove', { watchId }),
        renderRules,
      );
    });

  program
    .command('ui')
    .description('管理UIをbrowserで開く')
    .option('--print-url', 'browserを開かず、一回限りのURLを表示する', false)
    .option('--json', '結果をJSONで出力する', false)
    .action(async (options: { printUrl: boolean; json: boolean }) => {
      if (options.printUrl && options.json) {
        fail(
          new VdeError(
            'E_INVALID_ARGUMENT',
            '--print-urlの出力は秘密を含むため、--jsonとは併用できません。',
          ),
          true,
        );
        return;
      }
      await execute<UiResult>(
        'ui',
        options.json,
        () => showUi(options.printUrl),
        () => '',
      );
    });

  const renderStatus = (status: DaemonStatus) =>
    status.state === 'running'
      ? `running  pid=${String(status.pid)}  開いている文書 ${String(status.openDocuments)}件  ${status.uiUrl ?? ''}`
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
    .option(
      '--port <n>',
      '管理UIのport。指定がなければ空きportを使う',
      parseInteger('--port', 1, 65535),
    )
    .option(
      '--preview-port <n>',
      '文書を表示するlistenerのport。指定がなければ空きportを使う',
      parseInteger('--preview-port', 1, 65535),
    )
    .action(async (options: { port?: number; previewPort?: number }) => {
      try {
        const handle = await startDaemon({
          environment: context.environment,
          version: CLI_VERSION,
          ...(options.port === undefined ? {} : { managementPort: options.port }),
          ...(options.previewPort === undefined ? {} : { previewPort: options.previewPort }),
        });
        context.stderr(
          `daemonを前景で起動しました（pid=${String(process.pid)}、${handle.uiUrl}）。Ctrl+Cで停止します。\n`,
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
