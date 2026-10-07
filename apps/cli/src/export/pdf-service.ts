import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import type { HtmlPrintInput, HtmlPrintOutput, PrintInput } from '@vde-open/document/print';
import { LIMITS, VdeError } from '@vde-open/shared';

import type { DocumentService } from '../documents/service.ts';
import type { StateStore } from '../persistence/state-store.ts';
import { connectCdp, type CdpConnection } from './cdp.ts';

// The browser runs headless with a temporary profile of its own (removed afterwards) and is driven over a pipe,
// so no port is opened and the profile of a browser the user is running is never touched. The sandbox stays on.
const BROWSER_FLAGS = [
  '--headless',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--password-store=basic',
  '--use-mock-keychain',
];
// Page margin boxes (the header and footer) are supported from Chrome 131.
const MIN_BROWSER_VERSION = 131;
// After Browser.close (or a stop), how long to wait for the browser to exit before stopping it.
const EXIT_GRACE_MS = 5000;
// Exports waiting for the running one. More are refused.
const MAX_WAITING = 4;
const READ_CHUNK_BYTES = 1024 * 1024;
// Embedded assets are written once per reference. HTML and CSS together must stay within this budget.
const MAX_PAGE_BYTES = 256 * 1024 * 1024;
const TEMP_PREFIX = 'vde-open-pdf-';
// A temporary directory left this long (by a daemon that was killed) is removed. Exports finish well within it.
const STALE_TEMP_MS = 60 * 60 * 1000;
const PDF_HEAD = Buffer.from('%PDF-');
const PDF_TAIL = Buffer.from('%%EOF');

export interface PdfService {
  // A PDF of one revision, printed by a headless Chromium-based browser. HTML is always static.
  // Aborting the signal (the client went away) stops the browser.
  exportPdf(documentId: string, revision: string, signal?: AbortSignal): Promise<Buffer>;
  // Stops a running browser and refuses later exports.
  close(): Promise<void>;
}

export interface PdfServiceOptions {
  store: StateStore;
  documents: DocumentService;
  // Renders the print document. The daemon gives it a worker of its own.
  printer: {
    print(input: PrintInput): Promise<string>;
    printHtml(input: HtmlPrintInput): Promise<HtmlPrintOutput>;
  };
  // Path of the browser. Throws E_BROWSER_NOT_FOUND when there is none.
  findBrowser: () => string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  // Upper bound of HTML and CSS written for the browser, including embedded images and fonts.
  maxPageBytes?: number;
  tempRoot?: string;
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
}

interface EmbeddedAsset {
  mime: string;
  sha256: string;
}

interface PrintResult {
  product: string;
  pdf: Buffer;
}

function exportFailed(reason: string, details: Record<string, unknown> = {}): VdeError {
  return new VdeError('E_EXPORT_FAILED', 'The browser could not print the PDF.', {
    reason,
    ...details,
  });
}

const stopping = () => new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.');
const cancelled = () => new VdeError('E_INTERRUPTED', 'The PDF export was cancelled.');

function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Open a page, print it, and read the PDF back in chunks.
async function printPage(cdp: CdpConnection, url: string): Promise<PrintResult> {
  const { product } = await cdp.send<{ product: string }>('Browser.getVersion');
  const major = Number(/\/(\d+)\./.exec(product)?.[1] ?? '0');
  if (major < MIN_BROWSER_VERSION) {
    throw new VdeError(
      'E_BROWSER_NOT_FOUND',
      `Exporting a PDF needs Google Chrome or Microsoft Edge ${String(MIN_BROWSER_VERSION)} or later.`,
      { source: 'version', version: product },
    );
  }
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
  // Wait for the load of this navigation (its loaderId), not of the blank page the target opened with.
  // A load that arrives before the navigation reply is remembered.
  const seen = new Set<string>();
  let loaderId: string | null = null;
  const loaded = cdp.waitFor<{ name: string; loaderId: string }>(
    'Page.lifecycleEvent',
    sessionId,
    (event) => {
      if (event.name !== 'load') return false;
      if (loaderId === null) seen.add(event.loaderId);
      return event.loaderId === loaderId;
    },
  );
  // A failed navigation never loads. The wait then ends when the connection closes.
  loaded.catch(() => undefined);
  const navigation = await cdp.send<{ loaderId?: string; errorText?: string }>(
    'Page.navigate',
    { url },
    sessionId,
  );
  if (navigation.errorText !== undefined || navigation.loaderId === undefined) {
    throw exportFailed('load');
  }
  loaderId = navigation.loaderId;
  if (!seen.has(loaderId)) await loaded;
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);
  // A font used only by print CSS must be loaded before printing. The expression is ours, not document code.
  const ready = await cdp.send<{ exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    {
      expression:
        '(async () => { document.body.getBoundingClientRect(); await document.fonts.ready; })()',
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (ready.exceptionDetails !== undefined) throw exportFailed('load');
  const { stream } = await cdp.send<{ stream: string }>(
    'Page.printToPDF',
    {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      transferMode: 'ReturnAsStream',
    },
    sessionId,
  );
  const parts: Buffer[] = [];
  for (;;) {
    const chunk = await cdp.send<{ data: string; base64Encoded?: boolean; eof: boolean }>(
      'IO.read',
      { handle: stream, size: READ_CHUNK_BYTES },
      sessionId,
    );
    parts.push(Buffer.from(chunk.data, chunk.base64Encoded === true ? 'base64' : 'latin1'));
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream }, sessionId);
  return { product, pdf: Buffer.concat(parts) };
}

function isPdf(pdf: Buffer): boolean {
  let end = pdf.length;
  while (end > 0 && (pdf[end - 1] === 0x0a || pdf[end - 1] === 0x0d || pdf[end - 1] === 0x20)) {
    end -= 1;
  }
  return (
    pdf.subarray(0, PDF_HEAD.length).equals(PDF_HEAD) &&
    pdf.subarray(end - PDF_TAIL.length, end).equals(PDF_TAIL)
  );
}

export function createPdfService(options: PdfServiceOptions): PdfService {
  const { store, documents, printer } = options;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? LIMITS.pdfExportTimeoutMs;
  const tempRoot = options.tempRoot ?? tmpdir();
  const maxPageBytes = options.maxPageBytes ?? MAX_PAGE_BYTES;
  let closed = false;
  // Stops the running browser with the given reason. Null when no browser runs.
  let stopRunning: ((reason: VdeError) => void) | null = null;
  // Exports run one at a time, so at most one browser runs.
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  // The browser starts helper processes, which are stopped with it: on POSIX the browser leads its own process group,
  // and on Windows taskkill stops the whole process tree.
  // Helpers can outlive the browser, so on POSIX the group is stopped even after the browser itself exited.
  // It is called only while the export runs or right after the browser exited, before its group id could be reused.
  const kill = (child: ChildProcess) => {
    if (child.pid === undefined) return;
    if (platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).once('error', () => child.kill());
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  };

  // Embed images and fonts one at a time. HTML and CSS share the size budget of this export.
  const writePage = async (
    path: string,
    html: string,
    slot: string,
    assets: EmbeddedAsset[],
    budget: { written: number },
  ) => {
    const file = await open(path, 'wx', 0o600);
    const write = async (text: string) => {
      budget.written += Buffer.byteLength(text);
      if (budget.written > maxPageBytes) {
        throw new VdeError('E_LIMIT_EXCEEDED', 'The document is too large to print.', {
          reason: 'page-size',
          limit: maxPageBytes,
        });
      }
      await file.write(text);
    };
    try {
      let last = 0;
      for (const match of html.matchAll(new RegExp(`${slot}-(\\d+)`, 'g'))) {
        await write(html.slice(last, match.index));
        const asset = assets[Number(match[1])];
        if (asset !== undefined) {
          await write(`data:${asset.mime};base64,`);
          await write((await store.readBlob(asset.sha256)).toString('base64'));
        }
        last = match.index + match[0].length;
      }
      await write(html.slice(last));
    } finally {
      await file.close();
    }
  };

  // Directories left by a daemon that was killed while printing (they hold the page with the document's text).
  // Only real directories (not symlinks) of this user are removed: the temporary directory may be shared (/tmp).
  const uid = platform === 'win32' ? null : (process.getuid?.() ?? null);
  const sweepStale = async () => {
    const now = Date.now();
    for (const name of await readdir(tempRoot).catch(() => [])) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(tempRoot, name);
      const info = await lstat(path).catch(() => null);
      if (info === null || !info.isDirectory() || now - info.mtimeMs < STALE_TEMP_MS) continue;
      if (uid !== null && info.uid !== uid) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  void sweepStale();

  const print = async (
    browser: string,
    directory: string,
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<PrintResult> => {
    // The daemon may have started stopping while the page was written.
    if (closed) throw stopping();
    if (signal?.aborted === true) throw cancelled();
    const child = spawn(
      browser,
      [...BROWSER_FLAGS, `--user-data-dir=${join(directory, 'profile')}`, 'about:blank'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      },
    );
    const cdp = connectCdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
    let reason: VdeError | null = null;
    const stop = (why: VdeError) => {
      reason ??= why;
      cdp.close(why);
      kill(child);
    };
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        cdp.close(reason ?? exportFailed('exit'));
        resolve();
      });
      child.once('error', () => {
        stop(exportFailed('spawn'));
        resolve();
      });
    });
    const timer = setTimeout(() => stop(exportFailed('timeout', { timeoutMs })), timeoutMs);
    const onAbort = () => stop(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    stopRunning = stop;
    let printed: PrintResult | null = null;
    try {
      printed = await printPage(cdp, url);
      await cdp.send('Browser.close').catch(() => undefined);
      return printed;
    } catch (error) {
      if (reason !== null) throw reason;
      if (error instanceof VdeError) throw error;
      throw exportFailed('protocol');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stopRunning = null;
      // The temporary profile can be removed only after the browser has exited.
      if (printed === null) kill(child);
      if (!(await settledWithin(exited, EXIT_GRACE_MS))) {
        kill(child);
        await settledWithin(exited, EXIT_GRACE_MS);
      }
    }
  };

  const run = async (documentId: string, revision: string, signal: AbortSignal | undefined) => {
    const started = Date.now();
    const { record, entry } = documents.describeRevision(documentId, revision);
    const source = (await store.readBlob(entry.sourceSha256)).toString('utf8');
    const slot = randomBytes(16).toString('hex');
    let assets = entry.assets.filter((asset) => asset.role === 'image' || asset.role === 'svg');
    let html: string;
    let stylesheets: HtmlPrintOutput['stylesheets'] = [];
    if (entry.format === 'markdown') {
      html = await printer.print({
        source,
        title: record.title,
        documentLogicalPath: entry.documentLogicalPath,
        images: assets.map((asset) => asset.logicalPath),
        imageSlot: slot,
      });
    } else {
      const sheets: HtmlPrintInput['stylesheets'] = [];
      for (const asset of entry.assets) {
        if (asset.role !== 'style') continue;
        const bytes = await store.readBlob(asset.sha256);
        try {
          sheets.push({
            logicalPath: asset.logicalPath,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          });
        } catch {
          // As in the static view, CSS whose references cannot be scanned is not served.
        }
      }
      const readable = new Set(sheets.map((sheet) => sheet.logicalPath));
      assets = entry.assets.filter(
        (asset) =>
          asset.role === 'image' ||
          asset.role === 'svg' ||
          asset.role === 'font' ||
          (asset.role === 'style' && readable.has(asset.logicalPath)),
      );
      const output = await printer.printHtml({
        source,
        title: record.title,
        documentLogicalPath: entry.documentLogicalPath,
        assets: assets.map(({ logicalPath, role }) => ({ logicalPath, role })),
        stylesheets: sheets,
        assetSlot: slot,
      });
      html = output.html;
      stylesheets = output.stylesheets;
    }
    // Looked for after rendering, so the pack smoke test (with no browser) still checks the print document.
    const browser = options.findBrowser();
    // A private directory (0700) holds the page, the browser profile and nothing else, only while the browser runs.
    const directory = await mkdtemp(join(tempRoot, TEMP_PREFIX));
    try {
      const page = join(directory, 'document.html');
      const budget = { written: 0 };
      await writePage(page, html, slot, assets, budget);
      for (const sheet of stylesheets)
        await writePage(join(directory, sheet.name), sheet.css, slot, assets, budget);
      const { product, pdf } = await print(browser, directory, pathToFileURL(page).href, signal);
      if (!isPdf(pdf)) throw exportFailed('output');
      options.onEvent?.('pdf.exported', {
        bytes: pdf.length,
        elapsedMs: Date.now() - started,
        browser: product.split('/', 1)[0] ?? '',
      });
      return pdf;
    } finally {
      // A directory that cannot be removed (a helper process still holding a file) does not change the result.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        (error: unknown) => {
          options.onEvent?.('pdf.cleanup_failed', {
            code: (error as NodeJS.ErrnoException).code ?? 'unknown',
          });
        },
      );
    }
  };

  return {
    exportPdf(documentId, revision, signal) {
      if (closed) return Promise.reject(stopping());
      if (waiting >= MAX_WAITING) {
        return Promise.reject(
          new VdeError('E_LIMIT_EXCEEDED', 'Too many PDF exports are waiting.', {
            reason: 'waiting',
            limit: MAX_WAITING,
          }),
        );
      }
      // An export counts as waiting until it starts or its request is aborted.
      let counted = true;
      const uncount = () => {
        if (!counted) return;
        counted = false;
        waiting -= 1;
      };
      waiting += 1;
      signal?.addEventListener('abort', uncount, { once: true });
      const result = queue.then(() => {
        signal?.removeEventListener('abort', uncount);
        uncount();
        if (closed) throw stopping();
        if (signal?.aborted === true) throw cancelled();
        return run(documentId, revision, signal);
      });
      queue = result.catch((error: unknown) => {
        if (error instanceof VdeError && error.code !== 'E_INTERRUPTED') {
          options.onEvent?.('pdf.failed', {
            code: error.code,
            reason: String(error.details['reason'] ?? error.details['source'] ?? ''),
          });
        }
      });
      return result;
    },
    async close() {
      closed = true;
      stopRunning?.(stopping());
      await queue;
    },
  };
}
