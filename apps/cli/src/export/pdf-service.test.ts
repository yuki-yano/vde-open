import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  lutimesSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPrintDocument, type PrintInput } from '@vde-open/document/print';
import { scanReferences } from '@vde-open/document/render';
import { VdeError } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createPdfService, type PdfService, type PdfServiceOptions } from './pdf-service.ts';

const fixture = fileURLToPath(new URL('./fake-browser.fixture.ts', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let base: string;
let temp: string;
let store: StateStore;
let documents: DocumentService;
let service: PdfService | null;
let events: Array<{ event: string; fields: Record<string, string | number> }>;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-pdf-test-')));
  temp = join(base, 'temp');
  mkdirSync(temp);
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  documents = new DocumentService({
    store,
    cursors: createCursorCodec(randomBytes(32)),
    scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
  });
  service = null;
  events = [];
});

afterEach(async () => {
  await service?.close();
  // The locked mode leaves a directory that cannot be removed until it is writable again.
  for (const name of readdirSync(temp)) {
    const locked = join(temp, name, 'profile', 'locked');
    if (existsSync(locked)) chmodSync(locked, 0o700);
  }
  rmSync(base, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): void {
  const path = join(base, 'work', name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

// A browser executable that runs the fake in the given mode and records what it saw.
function fakeBrowser(mode: string): { path: string; record: string } {
  const record = join(base, `record-${mode}-${randomBytes(4).toString('hex')}.jsonl`);
  const path = join(base, `browser-${mode}-${randomBytes(4).toString('hex')}.sh`);
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" ${mode} "${record}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return { path, record };
}

function recorded(record: string): Array<Record<string, unknown>> {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function openMarkdown(): Promise<{ documentId: string; revision: string }> {
  write('docs/images/flow.png', PNG);
  write('docs/design.md', '# 設計メモ\n\n![図](images/flow.png)\n\n本文です。\n');
  const opened = await documents.open({ cwd: join(base, 'work'), paths: ['docs/design.md'] });
  const summary = opened.data.documents[0];
  return { documentId: summary?.documentId as string, revision: summary?.revision as string };
}

function create(browser: string, options: Partial<PdfServiceOptions> = {}): PdfService {
  service = createPdfService({
    store,
    documents,
    printer: { print: (input) => Promise.resolve(renderPrintDocument(input)) },
    findBrowser: () => browser,
    tempRoot: temp,
    onEvent: (event, fields) => events.push({ event, fields }),
    ...options,
  });
  return service;
}

describe('PDF export', () => {
  it('prints the revision with the browser driven over a pipe and removes its temporary directory', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('ok');
    const pdf = await create(browser.path).exportMarkdown(documentId, revision);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const [start, page, closed] = recorded(browser.record);
    const flags = start?.['flags'] as string[];
    expect(flags).toContain('--headless');
    expect(flags).toContain('--remote-debugging-pipe');
    expect(flags).not.toContain('--no-sandbox');
    const profile = flags.find((flag) => flag.startsWith('--user-data-dir='));
    expect(profile?.startsWith(`--user-data-dir=${temp}`)).toBe(true);
    // The image is written into the page as a data URL; the page has the title and loads nothing else.
    expect(page?.['page']).toContain(
      `<img src="data:image/png;base64,${PNG.toString('base64')}" alt="図">`,
    );
    expect(page?.['page']).toContain('<title>設計メモ</title>');
    expect(closed).toEqual({ closed: true });
    expect(readdirSync(temp)).toEqual([]);
    expect(events).toEqual([
      {
        event: 'pdf.exported',
        fields: expect.objectContaining({ bytes: pdf.length, browser: 'Chrome' }) as unknown,
      },
    ]);
  });

  it('refuses HTML documents without starting a browser', async () => {
    write('page.html', '<h1>見出し</h1>');
    const opened = await documents.open({ cwd: join(base, 'work'), paths: ['page.html'] });
    const summary = opened.data.documents[0];
    const browser = fakeBrowser('ok');
    await expect(
      create(browser.path).exportMarkdown(
        summary?.documentId as string,
        summary?.revision as string,
      ),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED_FORMAT' });
    expect(recorded(browser.record)).toEqual([]);
  });

  it('reports a missing browser', async () => {
    const { documentId, revision } = await openMarkdown();
    const missing = new VdeError('E_BROWSER_NOT_FOUND', 'No browser.', { source: 'search' });
    await expect(
      create('', {
        findBrowser: () => {
          throw missing;
        },
      }).exportMarkdown(documentId, revision),
    ).rejects.toBe(missing);
  });

  it('fails when the browser cannot be started', async () => {
    const { documentId, revision } = await openMarkdown();
    await expect(
      create(join(base, 'not-a-browser')).exportMarkdown(documentId, revision),
    ).rejects.toMatchObject({ code: 'E_EXPORT_FAILED', details: { reason: 'spawn' } });
    expect(readdirSync(temp)).toEqual([]);
  });

  it('refuses a browser older than Chrome 131 and stops it', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('old');
    await expect(create(browser.path).exportMarkdown(documentId, revision)).rejects.toMatchObject({
      code: 'E_BROWSER_NOT_FOUND',
      details: { source: 'version', version: 'HeadlessChrome/120.0.0.0' },
    });
    expect(alive(recorded(browser.record)[0]?.['pid'] as number)).toBe(false);
    expect(readdirSync(temp)).toEqual([]);
  });

  it.each([
    ['hang', 'timeout'],
    ['crash', 'exit'],
    ['garbage', 'output'],
  ])('fails when the browser does %s, and leaves no process or directory', async (mode, reason) => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser(mode);
    await expect(
      create(browser.path, { timeoutMs: 1000 }).exportMarkdown(documentId, revision),
    ).rejects.toMatchObject({ code: 'E_EXPORT_FAILED', details: { reason } });
    expect(alive(recorded(browser.record)[0]?.['pid'] as number)).toBe(false);
    expect(readdirSync(temp)).toEqual([]);
    expect(events).toEqual([{ event: 'pdf.failed', fields: { code: 'E_EXPORT_FAILED', reason } }]);
  });

  it('waits for the load of the page, not of the blank page the target opened with', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('stale');
    const pdf = await create(browser.path).exportMarkdown(documentId, revision);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('ends the export, not the daemon, when the browser writes a message that is not JSON', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('broken');
    await expect(create(browser.path).exportMarkdown(documentId, revision)).rejects.toMatchObject({
      code: 'E_EXPORT_FAILED',
      details: { reason: 'protocol' },
    });
    expect(alive(recorded(browser.record)[0]?.['pid'] as number)).toBe(false);
  });

  it('returns the PDF when its temporary directory cannot be removed, and records that', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('locked');
    const pdf = await create(browser.path).exportMarkdown(documentId, revision);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(events.map((entry) => entry.event)).toEqual(['pdf.exported', 'pdf.cleanup_failed']);
  });

  it('refuses a page beyond the size limit before starting a browser (an image repeated many times)', async () => {
    write('docs/images/flow.png', Buffer.alloc(3000, 1));
    write('docs/many.md', `${'![図](images/flow.png)\n\n'.repeat(10)}`);
    const opened = await documents.open({ cwd: join(base, 'work'), paths: ['docs/many.md'] });
    const summary = opened.data.documents[0];
    const browser = fakeBrowser('ok');
    await expect(
      create(browser.path, { maxPageBytes: 20_000 }).exportMarkdown(
        summary?.documentId as string,
        summary?.revision as string,
      ),
    ).rejects.toMatchObject({ code: 'E_LIMIT_EXCEEDED', details: { reason: 'page-size' } });
    expect(recorded(browser.record)).toEqual([]);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('starts no browser when the daemon stops while the print document is rendered', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('ok');
    let release!: () => void;
    const rendered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let printing!: () => void;
    const started = new Promise<void>((resolve) => {
      printing = resolve;
    });
    const pdfs = create(browser.path, {
      printer: {
        print: async (input: PrintInput) => {
          printing();
          await rendered;
          return renderPrintDocument(input);
        },
      },
    });
    const result = pdfs.exportMarkdown(documentId, revision);
    await started;
    const closing = pdfs.close();
    release();
    await expect(result).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    await closing;
    expect(recorded(browser.record)).toEqual([]);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('removes temporary directories left by a daemon that was killed, and keeps recent ones', async () => {
    const old = join(temp, 'vde-open-pdf-old');
    const recent = join(temp, 'vde-open-pdf-recent');
    const other = join(temp, 'something-else');
    // A symlink with the prefix is not followed: the directory it points to stays.
    const outside = join(base, 'outside');
    const link = join(temp, 'vde-open-pdf-link');
    for (const dir of [old, recent, other, outside]) mkdirSync(dir);
    writeFileSync(join(outside, 'keep'), 'x');
    symlinkSync(outside, link);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const path of [old, other, outside]) utimesSync(path, twoHoursAgo, twoHoursAgo);
    lutimesSync(link, twoHoursAgo, twoHoursAgo);
    create(fakeBrowser('ok').path);
    await expect.poll(() => existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it('stops a browser that does not exit after closing', { timeout: 20_000 }, async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('linger');
    const pdf = await create(browser.path).exportMarkdown(documentId, revision);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(alive(recorded(browser.record)[0]?.['pid'] as number)).toBe(false);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('runs one export at a time and stops the browser when the request is aborted', async () => {
    const { documentId, revision } = await openMarkdown();
    const hanging = fakeBrowser('hang');
    const working = fakeBrowser('ok');
    let browser = hanging.path;
    const pdfs = create('', { findBrowser: () => browser });
    const abort = new AbortController();
    const first = pdfs.exportMarkdown(documentId, revision, abort.signal);
    await expect.poll(() => recorded(hanging.record).length).toBe(2);
    browser = working.path;
    const second = pdfs.exportMarkdown(documentId, revision);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(recorded(working.record)).toEqual([]);

    abort.abort();
    await expect(first).rejects.toMatchObject({ code: 'E_INTERRUPTED' });
    expect(alive(recorded(hanging.record)[0]?.['pid'] as number)).toBe(false);
    expect((await second).subarray(0, 5).toString()).toBe('%PDF-');
    // A cancelled export is not recorded as a failure.
    expect(events.map((entry) => entry.event)).toEqual(['pdf.exported']);
  });

  it('refuses exports beyond the waiting limit, and stops the browser on close', async () => {
    const { documentId, revision } = await openMarkdown();
    const browser = fakeBrowser('hang');
    const pdfs = create(browser.path);
    const running = pdfs.exportMarkdown(documentId, revision);
    await expect.poll(() => recorded(browser.record).length).toBe(2);
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const waiting = aborts.map((abort) => pdfs.exportMarkdown(documentId, revision, abort.signal));
    await expect(pdfs.exportMarkdown(documentId, revision)).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { reason: 'waiting' },
    });
    // A waiting export whose request was aborted no longer counts.
    aborts[0]?.abort();
    waiting.push(pdfs.exportMarkdown(documentId, revision));

    await pdfs.close();
    await expect(running).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    for (const result of waiting)
      await expect(result).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    await expect(pdfs.exportMarkdown(documentId, revision)).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });
    expect(alive(recorded(browser.record)[0]?.['pid'] as number)).toBe(false);
    expect(readdirSync(temp)).toEqual([]);
  });
});
