// Performance measurement (spec 16.1, PERF-001 and PERF-002). The values are measurements against the design targets, not CI assertions.
// The management UI is measured with Playwright's Chromium (headless).
// Uses the distribution (apps/cli/dist) and runs with a temporary VDE_OPEN_HOME. The real state is not touched.
// Usage: pnpm build && pnpm perf
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { createDaemonControl } from '../apps/cli/src/cli/daemon-control.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli.js');

interface Fixture {
  name: string;
  documents: number;
  totalBytes: number;
}

const FIXTURES: Fixture[] = [
  { name: 'standard (100 documents / 10 MiB)', documents: 100, totalBytes: 10 * 1024 * 1024 },
  { name: 'load (1,000 documents / 50 MiB)', documents: 1000, totalBytes: 50 * 1024 * 1024 },
];

const QUERIES = [
  'session',
  '認証',
  '検索の設計',
  'retry policy',
  'Intl.Segmenter',
  '日本語',
  'cache',
  'daemon',
  '回答',
  'revision',
];
const SEARCH_ROUNDS = 5;

// Build a document with fixed content (the same arguments always give the same content).
function documentText(index: number, bytes: number): string {
  const words = [
    'sessionの期限は12時間で、操作がなければ失効する。',
    'The retry policy backs off exponentially with jitter.',
    '検索の設計では、Intl.Segmenterで日本語を分ける。',
    'The daemon keeps one canonical state and serializes commits.',
    'cacheは版ごとに持ち、古い版から捨てる。',
    '回答は、管理UIの送信でだけ確定する。',
    'Each revision is the SHA-256 of the canonical document record.',
  ];
  const parts = [`# 文書${String(index)}\n\n`];
  let size = parts[0]?.length ?? 0;
  let section = 0;
  while (size < bytes) {
    const line =
      section % 8 === 0
        ? `\n## 節${String(section)}\n\n`
        : `${words[(index + section) % words.length] ?? ''} ${String(section)}\n`;
    parts.push(line);
    size += Buffer.byteLength(line);
    section += 1;
  }
  return parts.join('');
}

function percentile(values: number[], ratio: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

const round = (value: number) => Math.round(value * 10) / 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function measureUi(
  url: string,
  count: number,
  lastPath: string,
  lastText: string,
): Promise<{ sidebarMs: number; selectMs: number; reflectMs: number }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const started = performance.now();
    await page.goto(url);
    const sidebar = page.getByRole('navigation', { name: 'Open documents' });
    await sidebar
      .getByRole('heading', { name: `Open documents (${String(count)})` })
      .waitFor({ timeout: 120_000 });
    const rows = await sidebar.locator('li').count();
    if (rows !== count) throw new Error(`the list has ${String(rows)} rows`);
    const sidebarMs = performance.now() - started;

    const title = `文書${String(count - 1)}`;
    const selectStarted = performance.now();
    const row = sidebar.getByRole('button', { name: title, exact: true });
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page
      .getByRole('region', { name: 'Document view' })
      .getByRole('heading', { level: 1, name: title, exact: true })
      .first()
      .waitFor({ timeout: 60_000 });
    const selectMs = performance.now() - selectStarted;

    const marker = `line after save ${String(Date.now())}`;
    const reflectStarted = performance.now();
    writeFileSync(lastPath, `${lastText}\n${marker}\n`);
    await page.getByText(marker).waitFor({ timeout: 60_000 });
    const reflectMs = performance.now() - reflectStarted;
    return { sidebarMs, selectMs, reflectMs };
  } finally {
    await browser.close();
  }
}

async function measure(fixture: Fixture): Promise<Record<string, string | number>> {
  const base = mkdtempSync(join(tmpdir(), 'vde-open-perf-'));
  const home = join(base, 'home');
  const work = join(base, 'work');
  mkdirSync(join(work, 'docs'), { recursive: true });
  const env = { ...process.env, VDE_OPEN_HOME: home };
  const perDocument = Math.floor(fixture.totalBytes / fixture.documents);
  for (let index = 0; index < fixture.documents; index += 1) {
    writeFileSync(
      join(work, 'docs', `doc-${String(index).padStart(4, '0')}.md`),
      documentText(index, perDocument),
    );
  }
  const cli = (args: string[]) =>
    execFileSync(process.execPath, [cliEntry, ...args, '--json'], {
      cwd: work,
      env,
      encoding: 'utf8',
    });
  try {
    // cold open: from starting the daemon to registering all documents.
    const coldStarted = performance.now();
    cli(['open', 'docs', '--recursive']);
    const coldOpenMs = performance.now() - coldStarted;

    const ipc = await createDaemonControl({
      env: { VDE_OPEN_HOME: home },
      platform: process.platform,
      homeDir: process.env['HOME'] ?? '',
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
    }).connectExisting();
    if (!ipc) throw new Error('cannot connect to the daemon');
    const call = async <T>(method: string, params: unknown = {}): Promise<T> => {
      const envelope = await ipc.request<T>(method, params, { timeoutMs: 120_000 });
      if (!envelope.ok) throw new Error(`${method}: ${JSON.stringify(envelope.error)}`);
      return envelope.data;
    };
    try {
      // indexing: until all documents are searchable.
      const indexStarted = performance.now();
      for (;;) {
        const result = await call<{ searchedDocuments: number; registeredDocuments: number }>(
          'documents.search',
          { query: 'session', limit: 1 },
        ).catch(() => null);
        if (result !== null && result.searchedDocuments >= fixture.documents) break;
        if (performance.now() - indexStarted > 600_000)
          throw new Error('indexing did not finish within 10 minutes');
        await sleep(100);
      }
      const indexMs = performance.now() - indexStarted;

      // warm search: repeat fixed queries.
      const searchMs: number[] = [];
      for (let roundIndex = 0; roundIndex < SEARCH_ROUNDS; roundIndex += 1) {
        for (const query of QUERIES) {
          const started = performance.now();
          await call('documents.search', { query, limit: 5 });
          searchMs.push(performance.now() - started);
        }
      }

      type Listed = Array<{ documentId: string; revision: string; displayPath: string | null }>;
      // The list returns at most 500 per call. Fetch the rest with the cursor.
      const listAll = async (): Promise<Listed> => {
        const all: Listed = [];
        let cursor: string | null = null;
        do {
          const page: { documents: Listed; nextCursor: string | null } = await call(
            'documents.list',
            cursor === null ? { limit: 500 } : { limit: 500, cursor },
          );
          all.push(...page.documents);
          cursor = page.nextCursor;
        } while (cursor !== null);
        return all;
      };
      const listStarted = performance.now();
      const listed = { documents: await listAll() };
      const listMs = performance.now() - listStarted;
      const target = listed.documents[Math.floor(listed.documents.length / 2)];
      if (!target) throw new Error('no documents');
      const readStarted = performance.now();
      await call('documents.read', { documentId: target.documentId });
      const readMs = performance.now() - readStarted;

      // update reflection: from rewriting the file until the revision in the list changes (the watch path).
      const updatePath = join(work, 'docs', 'doc-0000.md');
      const isFirst = (document: { displayPath: string | null }) =>
        document.displayPath?.endsWith('doc-0000.md') === true;
      const previous = listed.documents.find(isFirst)?.revision;
      const updateStarted = performance.now();
      writeFileSync(updatePath, `${documentText(0, perDocument)}\nupdated line\n`);
      let updateMs = -1;
      for (;;) {
        const updated = (await listAll()).find(isFirst);
        if (updated && previous !== undefined && updated.revision !== previous) {
          updateMs = performance.now() - updateStarted;
          break;
        }
        if (performance.now() - updateStarted > 30_000) break;
        await sleep(20);
      }

      // management UI (Chromium, headless): until all documents appear in the list, until the last document is selected and shown,
      // and from saving the shown document until its displayed body changes (checked in the DOM).
      const ui = await measureUi(
        execFileSync(process.execPath, [cliEntry, 'ui', '--print-url'], {
          cwd: work,
          env,
          encoding: 'utf8',
        }).trim(),
        fixture.documents,
        join(work, 'docs', `doc-${String(fixture.documents - 1).padStart(4, '0')}.md`),
        documentText(fixture.documents - 1, perDocument),
      );

      const idleBefore = await call<{ cpuMicros: number }>('daemon.diagnostics');
      await sleep(5000);
      const idleAfter = await call<{ cpuMicros: number; rssBytes: number }>('daemon.diagnostics');

      return {
        fixture: fixture.name,
        documents: listed.documents.length,
        coldOpenMs: round(coldOpenMs),
        indexMs: round(indexMs),
        searchP50Ms: round(percentile(searchMs, 0.5)),
        searchP95Ms: round(percentile(searchMs, 0.95)),
        listMs: round(listMs),
        readMs: round(readMs),
        updateReflectMs: updateMs < 0 ? 'timeout' : round(updateMs),
        uiSidebarMs: round(ui.sidebarMs),
        uiSelectMs: round(ui.selectMs),
        uiUpdateReflectMs: round(ui.reflectMs),
        idleCpuPercent: round(((idleAfter.cpuMicros - idleBefore.cpuMicros) / 1000 / 5000) * 100),
        rssMiB: round(idleAfter.rssBytes / 1024 / 1024),
      };
    } finally {
      ipc.close();
    }
  } finally {
    try {
      cli(['daemon', 'stop']);
    } catch {
      // already stopped.
    }
    rmSync(base, { recursive: true, force: true });
  }
}

const results = [];
for (const fixture of FIXTURES) results.push(await measure(fixture));
console.log(
  JSON.stringify(
    {
      environment: {
        platform: `${process.platform} ${process.arch}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        node: process.version,
      },
      results,
    },
    null,
    2,
  ),
);
