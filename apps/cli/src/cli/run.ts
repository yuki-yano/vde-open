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
    // Whether data is passed through a shell pipe or redirect.
    isPiped: boolean;
    read: () => Promise<Buffer>;
  };
}

export const CLI_VERSION: string = packageJson.version;

// The display name is fixed regardless of the invoked name (vde-open / vo). Both names
// produce the same output, and no state or daemon identifier is derived from the invoked name.
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
    message: 'An internal error occurred.',
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
    if (!/^\d+$/.test(value)) throw new InvalidArgumentError(`${label} must be an integer.`);
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
      throw new InvalidArgumentError(`${label} must be between ${String(min)} and ${String(max)}.`);
    }
    return parsed;
  };
}

function parseLines(value: string): { start: number; end: number } {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw new InvalidArgumentError('--lines must be in the form A:B.');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end < start) {
    throw new InvalidArgumentError('--lines must be 1 or greater, with A <= B.');
  }
  return { start, end };
}

function parseFormat(value: string): 'auto' | 'markdown' | 'html' {
  if (value === 'auto' || value === 'markdown' || value === 'html') return value;
  throw new InvalidArgumentError('--format must be one of auto, markdown, or html.');
}

function parseHtmlMode(value: string): 'static' | 'interactive' {
  if (value === 'static' || value === 'interactive') return value;
  throw new InvalidArgumentError('--html-mode must be static or interactive.');
}

function describeDocument(document: DocumentSummary): string {
  const path = document.displayPath ?? `(${document.sourceKind})`;
  return `${document.documentId}  ${escapeForTerminal(document.title)}  ${escapeForTerminal(path)}`;
}

function decodeStdin(bytes: Buffer): string {
  if (bytes.byteLength > LIMITS.documentBytes) {
    throw new VdeError(
      'E_LIMIT_EXCEEDED',
      'The stdin content exceeds the size limit for one document.',
      {
        limit: 'documentBytes',
        max: LIMITS.documentBytes,
        actual: bytes.byteLength,
      },
    );
  }
  if (bytes.includes(0)) {
    throw new VdeError('E_INVALID_SOURCE', 'The stdin content cannot be opened (contains-nul).', {
      path: 'stdin',
      reason: 'contains-nul',
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new VdeError('E_INVALID_SOURCE', 'The stdin content cannot be opened (invalid-utf8).', {
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
  throw new InvalidArgumentError('--status must be one of pending, submitted, or cancelled.');
}

function describeRequest(request: FeedbackForAgent): string {
  return `${request.requestId}  ${request.status}  ${escapeForTerminal(request.title)}  ${request.documentId}`;
}

// Show the answers. The values were typed by a person, so neutralize terminal control characters.
function describeAnswers(request: FeedbackForAgent): string {
  const lines = [describeRequest(request)];
  if (request.submission) {
    lines.push(`answer ${request.submission.submissionId} (${request.submission.submittedAt})`);
    for (const [name, value] of Object.entries(request.submission.answers)) {
      lines.push(
        `  ${escapeForTerminal(name)}: ${escapeContentForTerminal(JSON.stringify(value))}`,
      );
    }
    if (request.submission.confirmedAgainstOlderRevision) {
      lines.push(
        "  (answered against the question's revision after confirming that a newer revision exists)",
      );
    }
  }
  if (request.cancellation) lines.push(`cancelled: ${request.cancellation.reason}`);
  if (request.acknowledgedAt) lines.push(`acknowledged: ${request.acknowledgedAt}`);
  return lines.join('\n');
}

// Read the questionnaire file. Check the size before reading. The daemon validates the content.
async function readQuestionnaire(cwd: string, path: string): Promise<string> {
  const absolute = resolve(cwd, path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('not-file');
    size = info.size;
  } catch {
    throw new VdeError('E_PATH_NOT_FOUND', 'The questionnaire file cannot be read.', { path });
  }
  if (size > LIMITS.questionnaireBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', 'The questionnaire is too large.', {
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
    throw new VdeError('E_QUESTIONNAIRE_INVALID', 'The questionnaire cannot be read as UTF-8.', {
      path,
    });
  }
}

function parseSearchMode(value: string): 'text' | 'exact' | 'path' {
  if (value === 'text' || value === 'exact' || value === 'path') return value;
  throw new InvalidArgumentError('--mode must be one of text, exact, or path.');
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

  // Shared handling for every command. With JSON, write exactly one envelope to stdout (spec 5.6).
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

  // Open the management UI in the browser. If that fails, report it as a warning separate from the result of the open itself.
  const openBrowser = async (connection: IpcConnection): Promise<Warning[]> => {
    const { data } = unwrap(await connection.request<DaemonStatus>('daemon.status', {}));
    if (await browser.open(data.uiUrl ?? '')) return [];
    return [
      {
        code: 'W_BROWSER_OPEN_FAILED',
        message:
          'The browser could not be opened. Open the URL shown by `vde-open ui --print-url` in your browser.',
        details: { uiUrl: data.uiUrl },
      },
    ];
  };

  const showUi = async (printUrl: boolean, json = false): Promise<CommandOutcome<UiResult>> => {
    const connection = await control.ensure();
    try {
      if (printUrl) {
        const { data } = unwrap(await connection.request<DaemonStatus>('daemon.status', {}));
        if (!json) context.stdout(`${data.uiUrl ?? ''}\n`);
        return { data: { uiUrl: data.uiUrl ?? '', opened: false } };
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
      'Local CLI that shows Markdown, HTML, and images in the browser and lets agents search documents and read text',
    )
    .version(CLI_VERSION, '-V, --version', 'Show the version')
    .helpOption('-h, --help', 'Show help')
    .addHelpText(
      'after',
      '\n`vo` is the same command as `vde-open`. Passing a file directly is treated as `open` (for example: vo a.md).\nRunning with no arguments opens the management UI in the browser.',
    )
    .exitOverride()
    .configureOutput({ writeOut: context.stdout, writeErr: context.stderr })
    // No arguments is the same as `ui` (spec 5.1).
    .action(async () => {
      await execute<UiResult>(
        'ui',
        false,
        () => showUi(false),
        () => '',
      );
    });

  const openCommand = program.command('open');
  // Count only what the parser recognized as options. File names after `--` and option values are not counted.
  const seenOpenFlags = new Set<'open' | 'no-open'>();
  openCommand.on('option:open', () => seenOpenFlags.add('open'));
  openCommand.on('option:no-open', () => seenOpenFlags.add('no-open'));
  openCommand
    .description('Open documents. A directory or glob is expanded to the matching documents')
    .argument('[paths...]', 'File, directory, or glob. `-` means stdin')
    .option('--format <format>', 'auto, markdown, or html. Required for stdin', parseFormat, 'auto')
    .option('--title <text>', 'Title to display. Only for a single document')
    .option(
      '--key <key>',
      'Key that updates the stdin document as the same entry. Only for a single document',
    )
    .option('-R, --recursive', 'List directories recursively', false)
    .option('-w, --watch', 'Also open documents that newly appear in the directory or glob', false)
    .option(
      '--html-mode <mode>',
      'How to show HTML. static (default; scripts do not run) or interactive (scripts are allowed to run)',
      parseHtmlMode,
    )
    .option(
      '--assets-root <dir>',
      'Range of local files (images, CSS, etc.) that may be read. Defaults to the directory of the document',
    )
    .option(
      '--asset <path>',
      'Register a local file that document parsing does not find (path relative to assets-root). Can be repeated',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--open', 'Open the management UI in the browser')
    .option('--no-open', 'Do not open the browser')
    .option('--focus', 'Make the first specified document the displayed document', false)
    .option('--json', 'Output the result as JSON', false)
    .action(async (paths: string[], options: OpenOptions) => {
      await execute<OpenResult>(
        'open',
        options.json,
        async () => {
          if (seenOpenFlags.size === 2) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              '--open and --no-open cannot be used together.',
            );
          }
          const explicitStdin = paths.includes('-');
          const filePaths = paths.filter((path) => path !== '-');
          const fromStdin = explicitStdin || (filePaths.length === 0 && context.stdin.isPiped);
          if (fromStdin && filePaths.length > 0) {
            throw new VdeError('E_INVALID_ARGUMENT', 'stdin and paths cannot be used together.');
          }
          // When content is piped in but paths are also given, there is no way to decide which to open.
          if (!fromStdin && context.stdin.isPiped) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              'stdin and paths cannot be used together. Do not pipe content to stdin when opening paths.',
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
              throw new VdeError(
                'E_INVALID_ARGUMENT',
                '--format is required when opening from stdin.',
              );
            }
            // Read through EOF before registering. Partial content is not treated as a complete document.
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
            // Opening, opening the browser, and focusing are independent operations (spec 5.2).
            // Without an explicit flag, open the browser only when run from a terminal and the daemon was newly started.
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
              (rule) => `watch: ${rule.watchId}  ${escapeForTerminal(rule.pattern ?? rule.root)}`,
            ),
            `documents: ${String(data.documents.length)} (new ${String(data.created)}, updated ${String(data.updated)}, unchanged ${String(data.unchanged)})`,
          ].join('\n'),
      );
    });

  program
    .command('list')
    .description('List open documents')
    .option(
      '--limit <n>',
      `Number of results (default ${String(LIMITS.listLimitDefault)}, max ${String(LIMITS.listLimitMax)})`,
      parseInteger('--limit', 1, LIMITS.listLimitMax),
    )
    .option('--cursor <cursor>', 'nextCursor from the previous result')
    .option('--json', 'Output the result as JSON', false)
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
            `showing ${String(data.documents.length)} of ${String(data.totalDocuments)} open documents`,
          ].join('\n'),
      );
    });

  program
    .command('search')
    .description('Search open documents. Only open documents are searched')
    .argument('<query>', 'Words to search for. Treated literally, not as a regular expression')
    .option(
      '--mode <mode>',
      'text (word match; default), exact (contiguous string only), or path (file name and path only)',
      parseSearchMode,
    )
    .option(
      '--limit <n>',
      `Number of results (default ${String(LIMITS.searchLimitDefault)}, max ${String(LIMITS.searchLimitMax)})`,
      parseInteger('--limit', 1, LIMITS.searchLimitMax),
    )
    .option(
      '--document <documentId>',
      'Document ID to restrict the search to. Can be repeated',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--max-bytes <n>',
      `Maximum bytes of results (default ${String(LIMITS.readMaxBytesDefault)})`,
      parseInteger('--max-bytes', 1, Number.MAX_SAFE_INTEGER),
    )
    .option('--cursor <cursor>', 'nextCursor from the previous result')
    .option('--json', 'Output the result as JSON', false)
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
              `--max-bytes must be between ${String(LIMITS.readMaxBytesMin)} and ${String(LIMITS.readMaxBytesMax)}.`,
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
                `${hit.documentId}  ${hit.sectionId}  ${escapeForTerminal(hit.title)}${hit.headingPath.length > 0 ? `  > ${escapeForTerminal(hit.headingPath.join(' > '))}` : ''}\n    ${escapeForTerminal(hit.excerpt)}`,
            ),
            `hits: ${String(data.hits.length)} / searched documents: ${String(data.searchedDocuments)} (open documents: ${String(data.registeredDocuments)})${data.truncated ? '  more results available' : ''}`,
            ...(data.incomplete
              ? [
                  `Some documents could not be searched (indexing ${String(data.indexingDocuments.length)}, failed ${String(data.failedDocuments.length)})`,
                ]
              : []),
          ].join('\n'),
      );
    });

  program
    .command('read')
    .description('Read the source of an open document, its outline, or the body of one section')
    .argument('<documentId>', 'Document ID')
    .option('--outline', 'Read the outline', false)
    .option(
      '--section <sectionId>',
      'Read the extracted body of one section (for example: sec_0002)',
    )
    .option('--lines <A:B>', 'Line range of the source (1-based, inclusive)', parseLines)
    .option('--revision <revision>', 'Revision to read. Fails if it is no longer kept')
    .option(
      '--max-bytes <n>',
      `Maximum bytes of the body (default ${String(LIMITS.readMaxBytesDefault)})`,
      parseInteger('--max-bytes', 1, Number.MAX_SAFE_INTEGER),
    )
    .option('--cursor <cursor>', 'nextCursor from the previous result')
    .option('--json', 'Output the result as JSON', false)
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
              `--max-bytes must be between ${String(LIMITS.readMaxBytesMin)} and ${String(LIMITS.readMaxBytesMax)}.`,
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
              'Only one of --outline, --section, or --lines can be specified.',
            );
          }
          // A cursor continues with the revision and read kind it was issued for. The range and revision cannot change.
          if (options.cursor !== undefined && (selectors > 0 || options.revision !== undefined)) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              '--cursor cannot be combined with --revision, --outline, --section, or --lines.',
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
    .description('Remove documents from the list. The original files are not deleted')
    .argument('[targets...]', 'Document ID or path')
    .option('--all', 'Close all open documents and remove the watch rules too', false)
    .option('--json', 'Output the result as JSON', false)
    .action(async (targets: string[], options: { all: boolean; json: boolean }) => {
      await execute<CloseResult>(
        'close',
        options.json,
        () => viaDaemon('documents.close', { cwd: context.cwd, targets, all: options.all }),
        (data) =>
          `closed: ${String(data.closed.length)} (already closed: ${String(data.alreadyClosed.length)})`,
      );
    });

  program
    .command('focus')
    .description('Switch the document displayed in the management UI')
    .argument('<documentId>', 'Document ID')
    .option('--json', 'Output the result as JSON', false)
    .action(async (documentId: string, options: { json: boolean }) => {
      await execute<{ documentId: string }>(
        'focus',
        options.json,
        () => viaDaemon('documents.focus', { documentId }),
        (data) => `Switched the displayed document to ${data.documentId}`,
      );
    });

  program
    .command('refresh')
    .description('Re-read files. Without an argument, all open files')
    .argument('[documentId]', 'Document ID')
    .option('--json', 'Output the result as JSON', false)
    .action(async (documentId: string | undefined, options: { json: boolean }) => {
      await execute<RefreshResult>(
        'refresh',
        options.json,
        () => viaDaemon('documents.refresh', documentId === undefined ? {} : { documentId }),
        (data) =>
          `checked ${String(data.documents.length)} documents, updated ${String(data.changed.length)}`,
      );
    });

  const renderRules = (data: WatchListResult) =>
    data.watchRules.length === 0
      ? 'No watch rules'
      : data.watchRules
          .map(
            (rule) =>
              `${rule.watchId}  ${rule.kind}  ${escapeForTerminal(rule.pattern ?? rule.root)}${rule.recursive ? '  (recursive)' : ''}`,
          )
          .join('\n');

  const askCommand = program.command('ask');
  const seenAskFlags = new Set<'open' | 'no-open'>();
  askCommand.on('option:open', () => seenAskFlags.add('open'));
  askCommand.on('option:no-open', () => seenAskFlags.add('no-open'));
  askCommand
    .description(
      'Ask a person a question. The answer is entered and submitted in the management UI and received with `feedback wait`. Do not use it for secrets (passwords, API keys)',
    )
    .argument('<questionnaire>', 'Questionnaire JSON file')
    .option('--document <documentId>', 'Ask about an open document')
    .option(
      '--revision <revision>',
      'Revision of --document to ask about. Defaults to the current revision',
    )
    .option('--view <path>', 'Open the document, then ask about that revision')
    .option(
      '--html-mode <mode>',
      'How to show HTML opened with --view. With interactive, the HTML can send draft answers',
      parseHtmlMode,
    )
    .option('--assets-root <dir>', 'Range of local files that the --view document may read')
    .option(
      '--asset <path>',
      'Local file to register individually for the --view document (can be repeated)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--operation-id <uuid>',
      'Identifier that keeps a retry from creating the same question twice',
    )
    .option('--open', 'Open the management UI in the browser')
    .option('--no-open', 'Do not open the browser')
    .option('--focus', 'Make the asked document the displayed document', false)
    .option('--json', 'Output the result as JSON', false)
    .action(async (questionnaire: string, options: AskOptions) => {
      await execute<FeedbackCreateResult>(
        'ask',
        options.json,
        async () => {
          if (seenAskFlags.size === 2) {
            throw new VdeError(
              'E_INVALID_ARGUMENT',
              '--open and --no-open cannot be used together.',
            );
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
          `${describeRequest(data.request)}${data.replayed ? '\n(returned the existing question with the same operation ID)' : ''}`,
      );
    });

  // Wait for the answer. Even if the daemon stops or restarts, reconnect and keep waiting until the deadline set at the start.
  // On timeout or interrupt, the question stays pending (spec 11.3).
  const feedbackCommand = program
    .command('feedback')
    .description(
      'Check the status and answers of questions. Draft answers (input before submit) are not returned',
    );
  feedbackCommand
    .command('list')
    .description('List questions')
    .option('--status <status>', 'pending, submitted, or cancelled', parseFeedbackStatus)
    .option('--json', 'Output the result as JSON', false)
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
          [
            ...data.requests.map(describeRequest),
            `questions: ${String(data.requests.length)}`,
          ].join('\n'),
      );
    });
  feedbackCommand
    .command('get')
    .description('Get the status of a question and its submitted answers. Does not acknowledge')
    .argument('<requestId>', 'Question ID')
    .option('--json', 'Output the result as JSON', false)
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
    .description(
      'Wait until the answer is submitted or the question is cancelled. After the timeout, the question stays pending',
    )
    .argument('<requestId>', 'Question ID')
    .option(
      '--timeout <seconds>',
      `Seconds to wait (default ${String(LIMITS.feedbackWaitDefaultSeconds)}, max ${String(LIMITS.feedbackWaitMaxSeconds)})`,
      parseInteger('--timeout', 1, LIMITS.feedbackWaitMaxSeconds),
      LIMITS.feedbackWaitDefaultSeconds,
    )
    .option('--json', 'Output the result as JSON', false)
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
    .description(
      'Record that the submitted answers were received and handled. Repeating it gives the same result',
    )
    .argument('<requestId>', 'Question ID')
    .requiredOption('--submission-id <submissionId>', 'Answer ID (from the result of get or wait)')
    .option('--json', 'Output the result as JSON', false)
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
    .description('Cancel a pending question')
    .argument('<requestId>', 'Question ID')
    .option('--json', 'Output the result as JSON', false)
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
    .description(
      'Delete the record of a finished question. A pending question cannot be deleted. Files and documents are kept',
    )
    .argument('<requestId>', 'Question ID')
    .option('--yes', 'Confirm the deletion', false)
    .option('--json', 'Output the result as JSON', false)
    .action(async (requestId: string, options: { yes: boolean; json: boolean }) => {
      await execute<{ requestId: string; forgotten: boolean }>(
        'feedback.forget',
        options.json,
        () => viaDaemon('feedback.forget', { requestId, confirmed: options.yes }),
        (data) => `${data.requestId}  deleted`,
      );
    });

  const watchCommand = program.command('watch').description('List and remove watch rules');
  watchCommand
    .command('list')
    .description('List watch rules')
    .option('--json', 'Output the result as JSON', false)
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
    .description('Remove a watch rule. Open documents stay open')
    .argument('<watchId>', 'Watch rule ID')
    .option('--json', 'Output the result as JSON', false)
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
    .description('Open the management UI in the browser')
    .option('--print-url', 'Print the UI URL instead of opening the browser', false)
    .option('--json', 'Output the result as JSON', false)
    .action(async (options: { printUrl: boolean; json: boolean }) => {
      await execute<UiResult>(
        'ui',
        options.json,
        () => showUi(options.printUrl, options.json),
        () => '',
      );
    });

  const renderStatus = (status: DaemonStatus) =>
    status.state === 'running'
      ? `running  pid=${String(status.pid)}  open documents: ${String(status.openDocuments)}  ${status.uiUrl ?? ''}`
      : 'stopped';

  const daemon = program.command('daemon').description('Start, inspect, and stop the daemon');
  daemon
    .command('status')
    .description('Show the daemon status. Does not start a new daemon when stopped')
    .option('--json', 'Output the result as JSON', false)
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
    .description('Start the daemon. Reuses it if already running')
    .option('--json', 'Output the result as JSON', false)
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
    .description('Stop the daemon. Open documents stay registered')
    .option('--json', 'Output the result as JSON', false)
    .action(async (options: { json: boolean }) => {
      await execute<{ state: 'stopped'; wasRunning: boolean }>(
        'daemon.stop',
        options.json,
        async () => ({ data: { state: 'stopped', ...(await control.stop()) } }),
        (data) => (data.wasRunning ? 'Stopped' : 'Not running'),
      );
    });
  daemon
    .command('restart')
    .description('Stop the daemon, then start it')
    .option('--json', 'Output the result as JSON', false)
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
    .description('Run the daemon in the foreground. Press Ctrl+C to stop')
    .option(
      '--port <n>',
      'Port for the management UI. Defaults to a free port',
      parseInteger('--port', 1, 65535),
    )
    .option(
      '--preview-port <n>',
      'Port for the listener that shows documents. Defaults to a free port',
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
          `Started the daemon in the foreground (pid=${String(process.pid)}, ${handle.uiUrl}). Press Ctrl+C to stop.\n`,
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
    .description('Diagnose the state and the daemon')
    .option(
      '--repair',
      'Recover from a verified backup and reclaim the runtime of a stopped daemon',
      false,
    )
    .option('--yes', 'Confirm running --repair', false)
    .option('--json', 'Output the result as JSON', false)
    .action(async (options: { repair: boolean; yes: boolean; json: boolean }) => {
      await execute<DoctorReport>(
        'doctor',
        options.json,
        async () => {
          if (options.repair && !options.yes) {
            throw new VdeError(
              'E_CONFIRMATION_REQUIRED',
              '--repair may rewrite the state. Add --yes to run it.',
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
            `daemon: ${report.daemon.reachable ? 'running' : 'stopped'} (lock: ${report.daemon.lock})`,
            ...report.problems.map((problem) => `problem: ${problem.code} ${problem.message}`),
            ...report.repairs.map((repair) => `repair: ${repair}`),
            report.problems.length === 0 ? 'No problems found.' : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
      );
    });

  // Take the list of subcommands and the value-taking open options from the command definitions.
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
      // Argument error. Commander has already written its explanation to stderr. With JSON, also return an envelope.
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
