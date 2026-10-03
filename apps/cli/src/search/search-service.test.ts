import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocument } from '@vde-open/document';
import { LIMITS, VdeError } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createSearchService, type SearchService } from './search-service.ts';

let base: string;
let store: StateStore;
let documents: DocumentService;
let search: SearchService | null;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-search-')));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  documents = new DocumentService({ store, cursors: createCursorCodec(randomBytes(32)) });
  search = null;
});

afterEach(async () => {
  await search?.close();
  rmSync(base, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  mkdirSync(join(base, name, '..'), { recursive: true });
  writeFileSync(join(base, name), content);
}

interface FakeWorkerOptions {
  // Never begin indexing documents whose title contains this string (no reply).
  neverBegin?: string;
  // Delay the begin of documents whose title contains this string by this time.
  delayBegin?: { title: string; ms: number };
  // When adding documents whose title contains this string, block the worker for this time per 64Ki characters indexed.
  busyAppend?: { title: string; ms: number };
  // Delay the search reply for this query by this time.
  delaySearch?: { query: string; ms: number };
  // Sort hits by title instead of list order (so a document added later comes first).
  sortByTitle?: boolean;
  // Delay the diagnostics reply by this time.
  delayDiagnostics?: number;
}

// A test worker with the same protocol as the real one (begin, append content in parts, commit).
// For search, returns one hit per committed document in list order.
function fakeWorker(options: FakeWorkerOptions = {}): string {
  const path = join(base, `fake-worker-${String(Math.random()).slice(2)}.mjs`);
  writeFileSync(
    path,
    `import { parentPort } from 'node:worker_threads';
const options = ${JSON.stringify(options)};
const staged = new Map();
const committed = new Map();
const pause = new Int32Array(new SharedArrayBuffer(4));
const reply = (id, result) => parentPort.postMessage({ id, ok: true, result });
parentPort.on('message', (request) => {
  switch (request.op) {
    case 'begin': {
      const title = request.meta.title;
      if (options.neverBegin && title.includes(options.neverBegin)) return;
      staged.set(request.meta.documentId, request.meta);
      if (options.delayBegin && title.includes(options.delayBegin.title)) {
        setTimeout(() => reply(request.id, null), options.delayBegin.ms);
        return;
      }
      return reply(request.id, null);
    }
    case 'append': {
      const meta = staged.get(request.documentId);
      if (meta && options.busyAppend && meta.title.includes(options.busyAppend.title)) {
        // Block synchronously in proportion to the content added (like heavy indexing, no messages are processed meanwhile).
        // The weight is the indexed field length (counted like real indexing).
        const length = request.parts.reduce(
          (total, part) => total + part.body.length + part.heading.length,
          0,
        );
        Atomics.wait(pause, 0, 0, options.busyAppend.ms * Math.max(1, Math.ceil(length / 65536)));
      }
      return reply(request.id, null);
    }
    case 'commit':
      committed.set(request.documentId, staged.get(request.documentId));
      staged.delete(request.documentId);
      return reply(request.id, null);
    case 'abort':
      staged.delete(request.documentId);
      return reply(request.id, null);
    case 'meta': {
      const current = committed.get(request.meta.documentId);
      if (!current || current.revision !== request.meta.revision) return reply(request.id, false);
      committed.set(request.meta.documentId, request.meta);
      return reply(request.id, true);
    }
    case 'remove':
      staged.delete(request.documentId);
      committed.delete(request.documentId);
      return reply(request.id, null);
    case 'diagnostics':
      setTimeout(
        () => reply(request.id, { heapUsedBytes: 0, retained: { documents: committed.size } }),
        options.delayDiagnostics ?? 0,
      );
      return;
    case 'search': {
      const hits = [...committed.values()]
        .toSorted((a, b) =>
          options.sortByTitle ? a.title.localeCompare(b.title) : a.order - b.order,
        )
        .map((meta) => ({
          documentId: meta.documentId, revision: meta.revision, title: meta.title,
          displayPath: meta.displayPath, sectionId: 'sec_0001', headingPath: [], excerpt: 'x',
          matchKind: 'text', score: 1, sourceRange: null, extraction: 'markdown',
        }));
      if (options.delaySearch && request.query === options.delaySearch.query) {
        setTimeout(() => reply(request.id, hits), options.delaySearch.ms);
        return;
      }
      return reply(request.id, hits);
    }
  }
});
`,
  );
  return path;
}

const idsOf = (opened: Awaited<ReturnType<DocumentService['open']>>) =>
  opened.data.documents.map((entry) => entry.documentId);

describe('SRCH-015 search while the index has not caught up', () => {
  it('with the real worker, open documents are searchable and the list shows the search state', async () => {
    write('a.md', '# 認証\n\nセッションの有効期限。\n');
    const opened = await documents.open({ cwd: base, paths: ['a.md'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    search = createSearchService({ store, cursors: createCursorCodec(randomBytes(32)) });
    expect(search.stateOf(documentId)).toBe('indexing');
    const found = await search.search({ query: '有効期限' });
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([documentId]);
    expect(found.data).toMatchObject({
      incomplete: false,
      searchedDocuments: 1,
      indexingDocuments: [],
    });
    expect(search.stateOf(documentId)).toBe('ready');
    expect(Date.parse(found.data.indexedAt)).not.toBeNaN();
  });

  it('if a document never finishes indexing, reports it and does not claim all documents were searched', async () => {
    write('fast.md', '# FAST\n\n本文。\n');
    write('slow.md', '# SLOW\n\n本文。\n');
    const opened = await documents.open({ cwd: base, paths: ['fast.md', 'slow.md'] });
    const [fast, slow] = opened.data.documents.map((entry) => entry.documentId) as [string, string];
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ neverBegin: 'SLOW' }),
      timeoutMs: 60_000,
    });
    const startedAt = Date.now();
    const found = await search.search({ query: '本文' });
    // Waiting for the index is bounded by a fixed time.
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([fast]);
    expect(found.data).toMatchObject({
      incomplete: true,
      registeredDocuments: 2,
      searchedDocuments: 1,
      indexingDocuments: [slow],
      failedDocuments: [],
    });
    expect(search.stateOf(slow)).toBe('indexing');
  });

  it('when no document is searchable yet, returns not-ready instead of an empty result', async () => {
    write('slow.md', '# SLOW\n\n本文。\n');
    await documents.open({ cwd: base, paths: ['slow.md'] });
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ neverBegin: 'SLOW' }),
      timeoutMs: 60_000,
    });
    await expect(search.search({ query: '本文' })).rejects.toMatchObject({
      code: 'E_INDEX_NOT_READY',
      retryable: true,
    });
  });

  it('a document whose indexing times out is treated as failed, and other documents remain searchable', async () => {
    write('slow.md', '# SLOW\n\n本文。\n');
    write('fast.md', '# FAST\n\n本文。\n');
    const opened = await documents.open({ cwd: base, paths: ['slow.md', 'fast.md'] });
    const [slow, fast] = opened.data.documents.map((entry) => entry.documentId) as [string, string];
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ neverBegin: 'SLOW' }),
      // Shorter than the search's wait for the index (2 seconds), but long enough to start a worker
      // and answer a search on slow CI runners.
      timeoutMs: 1000,
    });
    const found = await search.search({ query: '本文' });
    expect(found.data.failedDocuments).toEqual([{ documentId: slow, code: 'E_INDEX_NOT_READY' }]);
    expect(found.data.incomplete).toBe(true);
    expect(search.stateOf(slow)).toBe('excluded');
    // After the worker is recreated, searching again returns results for searchable documents.
    const again = await search.search({ query: '本文' });
    expect(again.data.hits.map((hit) => hit.documentId)).toEqual([fast]);
    expect(again.data.failedDocuments).toEqual([{ documentId: slow, code: 'E_INDEX_NOT_READY' }]);
  });
});

describe('SRCH-015 wait limit while the index is being built', () => {
  it('while a large document is being added, search returns after the wait limit plus at most one in-progress step', async () => {
    write('small.md', '# 小さい文書\n\n本文。\n');
    // A document with many sections each exceeding the per-step amount.
    const sections = Array.from(
      { length: 20 },
      (_, index) => `# 節${String(index)}\n\n${'本文の語。'.repeat(16_000)}\n`,
    );
    write('big.md', `# BIG\n\n${sections.join('\n')}`);
    const [small, big] = idsOf(await documents.open({ cwd: base, paths: ['small.md', 'big.md'] }));
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      // Block the worker 300ms per 64Ki characters (over 6 seconds for the whole document).
      workerPath: fakeWorker({ busyAppend: { title: 'BIG', ms: 300 } }),
      timeoutMs: 60_000,
    });
    const startedAt = Date.now();
    const found = await search.search({ query: '本文' });
    const elapsed = Date.now() - startedAt;
    // Returns within the 2-second wait plus one in-progress step (300ms) plus some margin.
    expect(elapsed).toBeLessThan(LIMITS.searchIndexWaitMs + 1000);
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([small]);
    expect(found.data).toMatchObject({ incomplete: true, indexingDocuments: [big] });
  });
});

describe('SRCH-008 cursors and changes in searchable documents', () => {
  it('does not continue if a document that was still indexing became searchable after the previous page', async () => {
    write('b.md', '# B\n\n本文。\n');
    write('c.md', '# C\n\n本文。\n');
    write('late.md', '# A-LATE\n\n本文。\n');
    const late = idsOf(
      await documents.open({ cwd: base, paths: ['b.md', 'c.md', 'late.md'] }),
    )[2] as string;
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      // The last document takes longer to index than the wait limit. It comes first in the results.
      workerPath: fakeWorker({ delayBegin: { title: 'LATE', ms: 2600 }, sortByTitle: true }),
      timeoutMs: 60_000,
    });
    const first = await search.search({ query: '本文', limit: 1 });
    expect(first.data.indexingDocuments).toEqual([late]);
    expect(first.data.nextCursor).not.toBeNull();
    while (search.stateOf(late) !== 'ready') await new Promise((done) => setTimeout(done, 50));
    // The catalog version is the same but the hit order changed (a new first hit). Continuing would cause gaps or duplicates.
    await expect(
      search.search({ query: '本文', limit: 1, cursor: first.data.nextCursor as string }),
    ).rejects.toMatchObject({
      code: 'E_CURSOR_STALE',
      details: { reason: 'results', restart: true },
    });
  });

  it('if the list changes while a continuation waits, the old offset is not applied to the new list', async () => {
    write('a.md', '# A\n\n本文。\n');
    write('b.md', '# B\n\n本文。\n');
    write('c.md', '# C\n\n本文。\n');
    const [a] = idsOf(await documents.open({ cwd: base, paths: ['a.md', 'b.md', 'c.md'] }));
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ delaySearch: { query: '本文', ms: 500 } }),
      timeoutMs: 60_000,
    });
    const first = await search.search({ query: '本文', limit: 1 });
    expect(first.data.hits.map((hit) => hit.documentId)).toEqual([a]);
    const second = search.search({
      query: '本文',
      limit: 1,
      cursor: first.data.nextCursor as string,
    });
    await new Promise((done) => setTimeout(done, 100));
    await documents.close({ cwd: base, targets: [a as string] });
    await expect(second).rejects.toMatchObject({
      code: 'E_CURSOR_STALE',
      details: { reason: 'catalog' },
    });
  });
});

describe('SRCH-002 title and path changes', () => {
  it('changing only the title updates search and hit titles without changing the content', async () => {
    write('a.md', '本文。\n');
    await documents.open({ cwd: base, paths: ['a.md'], title: 'OldBeacon' });
    search = createSearchService({ store, cursors: createCursorCodec(randomBytes(32)) });
    expect((await search.search({ query: 'OldBeacon' })).data.hits).toHaveLength(1);
    await documents.open({ cwd: base, paths: ['a.md'], title: 'NewBeacon' });
    const renamed = await search.search({ query: 'NewBeacon' });
    expect(renamed.data.hits).toEqual([expect.objectContaining({ title: 'NewBeacon' })]);
    expect(renamed.data.incomplete).toBe(false);
    expect((await search.search({ query: 'OldBeacon' })).data.hits).toEqual([]);
  });
});

describe('SRCH-015 / DOC-012 no searchable documents', () => {
  it('if no target document can be analyzed, returns an error with details instead of an empty result', async () => {
    write('a.md', '# A\n\n本文。\n');
    const [a] = idsOf(await documents.open({ cwd: base, paths: ['a.md'] }));
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: () =>
        Promise.reject(new VdeError('E_PARSE_FAILED', 'Cannot analyze.', { reason: 'test' })),
    });
    await expect(search.search({ query: '本文' })).rejects.toMatchObject({
      code: 'E_INDEX_NOT_READY',
      details: {
        failedDocuments: [{ documentId: a, code: 'E_PARSE_FAILED' }],
        indexingDocuments: [],
      },
    });
  });
});

describe('SRCH-011 empty documents', () => {
  it('the section of a hit in an empty document can be read as is', async () => {
    write('empty.md', '');
    const [empty] = idsOf(await documents.open({ cwd: base, paths: ['empty.md'] }));
    search = createSearchService({ store, cursors: createCursorCodec(randomBytes(32)) });
    const found = await search.search({ query: 'empty.md', mode: 'path' });
    const hit = found.data.hits[0];
    expect(hit).toMatchObject({ documentId: empty, sectionId: 'sec_0000' });
    const reader = new DocumentService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
    });
    const section = await reader.read({
      documentId: empty as string,
      revision: hit?.revision,
      section: hit?.sectionId,
    });
    expect(section.data).toMatchObject({ mode: 'section', sectionId: 'sec_0000', content: '' });
  });
});

describe('SRCH-015 documents with many short sections', () => {
  it('with many body-less sections, batches are cut by heading size and search is not kept waiting', async () => {
    write('small.md', '# 小さい文書\n\n本文。\n');
    // A document with no body but large total headings (about 6 million characters indexed).
    const children = Array.from(
      { length: 3000 },
      (_, index) => `## 節${String(index)} ${'x'.repeat(2000)}\n`,
    );
    write('wide.md', `# WIDE\n\n${children.join('\n')}`);
    const [small, wide] = idsOf(
      await documents.open({ cwd: base, paths: ['small.md', 'wide.md'] }),
    );
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ busyAppend: { title: 'WIDE', ms: 50 } }),
      timeoutMs: 60_000,
    });
    const startedAt = Date.now();
    const found = await search.search({ query: '本文' });
    expect(Date.now() - startedAt).toBeLessThan(LIMITS.searchIndexWaitMs + 1000);
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([small]);
    expect(found.data.indexingDocuments).toEqual([wide]);
  });
});

// Hold analysis until signalled.
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((done) => setTimeout(done, 10));
}

describe('SRCH-002 changes during indexing', () => {
  it('returning to a revision whose indexing was aborted re-indexes it and makes it searchable', async () => {
    write('a.md', '# A\n\nGATE-A 版Aの語。\n');
    write('other.md', '# O\n\nGATE-O ほかの文書。\n');
    const [a] = idsOf(await documents.open({ cwd: base, paths: ['a.md', 'other.md'] }));
    const gateA = gate();
    const gateO = gate();
    const calls = { a: 0, other: 0 };
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: async (format, text) => {
        if (text.includes('GATE-A')) {
          calls.a += 1;
          await gateA.wait;
        }
        if (text.includes('GATE-O')) {
          calls.other += 1;
          await gateO.wait;
        }
        return analyzeDocument(text, format);
      },
    });
    search.sync();
    await until(() => calls.a === 1);
    // While waiting for revision A's analysis, the document changes to revision B.
    write('a.md', '# A\n\n版Bの語。\n');
    await documents.open({ cwd: base, paths: ['a.md'] });
    search.sync();
    // Revision A's analysis finishes (no longer used). While waiting for the next document's analysis, it returns to revision A.
    gateA.open();
    await until(() => calls.other === 1);
    write('a.md', '# A\n\nGATE-A 版Aの語。\n');
    await documents.open({ cwd: base, paths: ['a.md'] });
    search.sync();
    gateO.open();
    const found = await search.search({ query: '版Aの語' });
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([a]);
    expect(found.data.incomplete).toBe(false);
    expect(calls.a).toBe(2);
  });

  it('a document waiting for its title update is not counted as searched and is shown as indexing in the list', async () => {
    write('a.md', '本文。\n');
    write('c.md', '# C\n\n本文。\n');
    const [a, c] = idsOf(
      await documents.open({ cwd: base, paths: ['a.md', 'c.md'], title: undefined }),
    );
    await documents.open({ cwd: base, paths: ['a.md'], title: 'OldBeacon' });
    const slowGate = gate();
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: async (format, text) => {
        if (text.includes('GATE-SLOW')) await slowGate.wait;
        return analyzeDocument(text, format);
      },
    });
    expect((await search.search({ query: 'OldBeacon' })).data.hits).toHaveLength(1);
    // Hold the sync with another document's analysis.
    write('slow.md', '# S\n\nGATE-SLOW\n');
    const [slow] = idsOf(await documents.open({ cwd: base, paths: ['slow.md'] }));
    search.sync();
    await documents.open({ cwd: base, paths: ['a.md'], title: 'NewBeacon' });
    search.sync();
    const pending = await search.search({ query: 'NewBeacon' });
    expect(pending.data).toMatchObject({
      hits: [],
      incomplete: true,
      searchedDocuments: 1,
    });
    expect(pending.data.indexingDocuments.toSorted()).toEqual([a, slow].toSorted());
    expect(search.stateOf(a as string)).toBe('indexing');
    expect(search.stateOf(c as string)).toBe('ready');
    slowGate.open();
    const done = await search.search({ query: 'NewBeacon' });
    expect(done.data.hits).toEqual([
      expect.objectContaining({ documentId: a, title: 'NewBeacon' }),
    ]);
    expect(done.data.incomplete).toBe(false);
  });
});

describe('SRCH-001 documents closed during indexing', () => {
  it('a document closed after its update indexing was aborted disappears from search, including previously committed content, and other documents can be paged', async () => {
    write('a.md', '# A\n\n本文。\n');
    write('b.md', '# B\n\n本文。\n');
    write('c.md', '# C\n\n本文。\n');
    const [a, b, c] = idsOf(await documents.open({ cwd: base, paths: ['a.md', 'b.md', 'c.md'] }));
    const hold = gate();
    let held = 0;
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: async (format, text) => {
        if (text.includes('GATE')) {
          held += 1;
          await hold.wait;
        }
        return analyzeDocument(text, format);
      },
    });
    expect((await search.search({ query: '本文', limit: 5 })).data.hits).toHaveLength(3);
    // Update an indexed document and close it while waiting for its analysis.
    write('a.md', '# A\n\nGATE 本文。\n');
    await documents.open({ cwd: base, paths: ['a.md'] });
    search.sync();
    await until(() => held === 1);
    await documents.close({ cwd: base, targets: [a as string] });
    hold.open();
    search.sync();
    let found = await search.search({ query: '本文', limit: 1 });
    for (let attempt = 0; attempt < 20 && found.data.incomplete; attempt += 1) {
      await new Promise((done) => setTimeout(done, 50));
      found = await search.search({ query: '本文', limit: 1 });
    }
    expect(found.data).toMatchObject({
      incomplete: false,
      indexingDocuments: [],
      failedDocuments: [],
    });
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([b]);
    const next = await search.search({
      query: '本文',
      limit: 1,
      cursor: found.data.nextCursor as string,
    });
    expect(next.data.hits.map((hit) => hit.documentId)).toEqual([c]);
  });
});

describe('diagnostics and shutdown', () => {
  it('after the index sync, aborting while waiting for the worker diagnostics reply ends without waiting', async () => {
    write('a.md', '# 診断\n\n本文。\n');
    await documents.open({ cwd: base, paths: ['a.md'] });
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ delayDiagnostics: 3000 }),
    });
    // First sync the index to the current documents and start the worker (search waits for indexing).
    await search.search({ query: '本文' });
    const controller = new AbortController();
    const started = Date.now();
    const waiting = search.diagnostics(false, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
