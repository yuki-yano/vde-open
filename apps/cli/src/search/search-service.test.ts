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
  // titleにこの文字列を含む文書の登録を始めない（応答しない）。
  neverBegin?: string;
  // titleにこの文字列を含む文書の登録の開始を、この時間だけ遅らせる。
  delayBegin?: { title: string; ms: number };
  // titleにこの文字列を含む文書を入れるとき、索引に入れる量64Ki文字ごとに、workerをこの時間だけ塞ぐ。
  busyAppend?: { title: string; ms: number };
  // このqueryの検索の応答を、この時間だけ遅らせる。
  delaySearch?: { query: string; ms: number };
  // hitを、一覧の順番ではなくtitleの順に並べる（後から入った文書が先頭に来る状況を作る）。
  sortByTitle?: boolean;
  // 診断の応答を、この時間だけ遅らせる。
  delayDiagnostics?: number;
}

// 本物のworkerと同じやり取り（始める→本文を分けて入れる→確定する）をする試験用worker。
// 検索では、確定した文書ごとに1件のhitを、一覧の順番で返す。
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
        // 入れる本文の量に比例して、同期的に塞ぐ（重い索引作成と同じく、この間は次のmessageを処理できない）。
        // 重さは、索引に入れるfieldの長さ（本物の登録と同じ数え方）。
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

describe('SRCH-015 indexが追い付いていないときの検索', () => {
  it('実際のworkerで、開いた文書を検索でき、一覧に検索の状態が出る', async () => {
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

  it('登録の終わらない文書があれば、その文書を示して、全件を検索したとは答えない', async () => {
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
    // indexへの反映を待つのは、決まった時間まで。
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

  it('どの文書もまだ検索できないときは、空の結果ではなく、準備できていないことを返す', async () => {
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

  it('処理が期限内に終わらない文書は失敗として扱い、ほかの文書の検索は続けられる', async () => {
    write('slow.md', '# SLOW\n\n本文。\n');
    write('fast.md', '# FAST\n\n本文。\n');
    const opened = await documents.open({ cwd: base, paths: ['slow.md', 'fast.md'] });
    const [slow, fast] = opened.data.documents.map((entry) => entry.documentId) as [string, string];
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ neverBegin: 'SLOW' }),
      timeoutMs: 300,
    });
    const found = await search.search({ query: '本文' });
    expect(found.data.failedDocuments).toEqual([{ documentId: slow, code: 'E_INDEX_NOT_READY' }]);
    expect(found.data.incomplete).toBe(true);
    expect(search.stateOf(slow)).toBe('excluded');
    // workerを作り直した後、もう一度検索すると、検索できる文書の結果が返る。
    const again = await search.search({ query: '本文' });
    expect(again.data.hits.map((hit) => hit.documentId)).toEqual([fast]);
    expect(again.data.failedDocuments).toEqual([{ documentId: slow, code: 'E_INDEX_NOT_READY' }]);
  });
});

describe('SRCH-015 indexを作っている間の待機の上限', () => {
  it('大きい文書を入れている途中でも、検索は待機の上限の後、入れている途中の1回分だけ待って返る', async () => {
    write('small.md', '# 小さい文書\n\n本文。\n');
    // 1回で入れる量を超える節を、いくつも持つ文書。
    const sections = Array.from(
      { length: 20 },
      (_, index) => `# 節${String(index)}\n\n${'本文の語。'.repeat(16_000)}\n`,
    );
    write('big.md', `# BIG\n\n${sections.join('\n')}`);
    const [small, big] = idsOf(await documents.open({ cwd: base, paths: ['small.md', 'big.md'] }));
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      // 64Ki文字ごとに、workerを300ms塞ぐ（文書全体で6秒以上）。
      workerPath: fakeWorker({ busyAppend: { title: 'BIG', ms: 300 } }),
      timeoutMs: 60_000,
    });
    const startedAt = Date.now();
    const found = await search.search({ query: '本文' });
    const elapsed = Date.now() - startedAt;
    // 反映を待つ2秒と、入れている途中の1回分（300ms）に、余裕を足した時間で返る。
    expect(elapsed).toBeLessThan(LIMITS.searchIndexWaitMs + 1000);
    expect(found.data.hits.map((hit) => hit.documentId)).toEqual([small]);
    expect(found.data).toMatchObject({ incomplete: true, indexingDocuments: [big] });
  });
});

describe('SRCH-008 cursorと、検索できる文書の変化', () => {
  it('前のページの後に、反映を待っていた文書が検索できるようになったら、続きを返さない', async () => {
    write('b.md', '# B\n\n本文。\n');
    write('c.md', '# C\n\n本文。\n');
    write('late.md', '# A-LATE\n\n本文。\n');
    const late = idsOf(
      await documents.open({ cwd: base, paths: ['b.md', 'c.md', 'late.md'] }),
    )[2] as string;
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      // 最後の文書の登録が、反映の待機より長くかかる。その文書は、検索結果では先頭に来る。
      workerPath: fakeWorker({ delayBegin: { title: 'LATE', ms: 2600 }, sortByTitle: true }),
      timeoutMs: 60_000,
    });
    const first = await search.search({ query: '本文', limit: 1 });
    expect(first.data.indexingDocuments).toEqual([late]);
    expect(first.data.nextCursor).not.toBeNull();
    while (search.stateOf(late) !== 'ready') await new Promise((done) => setTimeout(done, 50));
    // 一覧の版は同じだが、hitの並びが変わった（先頭に入った）。続きを返すと抜けや重複が起きる。
    await expect(
      search.search({ query: '本文', limit: 1, cursor: first.data.nextCursor as string }),
    ).rejects.toMatchObject({
      code: 'E_CURSOR_STALE',
      details: { reason: 'results', restart: true },
    });
  });

  it('続きの検索を待っている間に一覧が変わったら、古い位置を新しい一覧へ当てはめない', async () => {
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

describe('SRCH-002 titleとpathの変更', () => {
  it('本文を変えずにtitleだけを変えても、検索とhitのtitleが新しいtitleになる', async () => {
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

describe('SRCH-015 / DOC-012 検索できる文書がない', () => {
  it('対象の文書がすべて解析できなければ、空の結果ではなく、内訳を付けたerrorを返す', async () => {
    write('a.md', '# A\n\n本文。\n');
    const [a] = idsOf(await documents.open({ cwd: base, paths: ['a.md'] }));
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      analyze: () =>
        Promise.reject(new VdeError('E_PARSE_FAILED', '解析できません。', { reason: 'test' })),
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

describe('SRCH-011 空の文書', () => {
  it('空の文書のhitの節を、そのまま取得できる', async () => {
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

describe('SRCH-015 本文の短い節が多い文書', () => {
  it('本文のない節が多くても、見出しの量で1回の登録を区切り、検索を待たせ続けない', async () => {
    write('small.md', '# 小さい文書\n\n本文。\n');
    // 本文はないが、見出しの合計が大きい文書（索引に入れる量は約600万文字）。
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

// 解析を、合図があるまで止める。
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

describe('SRCH-002 登録の途中での変更', () => {
  it('登録を中断した版へ戻っても、その版を入れ直して検索できる', async () => {
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
    // 版Aの解析を待っている間に、版Bへ変わる。
    write('a.md', '# A\n\n版Bの語。\n');
    await documents.open({ cwd: base, paths: ['a.md'] });
    search.sync();
    // 版Aの解析が終わる（もう使わない）。次の文書の解析を待っている間に、版Aへ戻る。
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

  it('titleの反映を待っている文書は、検索済みとして数えず、一覧でも登録中にする', async () => {
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
    // 別の文書の解析で、同期を待たせる。
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

describe('SRCH-001 登録の途中で閉じた文書', () => {
  it('更新の登録を中断した後に閉じた文書は、前に確定した内容も検索から消え、ほかの文書の続きを取れる', async () => {
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
    // 登録済みの文書を更新し、その解析を待っている間に閉じる。
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

describe('診断と停止', () => {
  it('indexの同期の後、workerの診断の応答を待っている間に中断されたら、待たずに終える', async () => {
    write('a.md', '# 診断\n\n本文。\n');
    await documents.open({ cwd: base, paths: ['a.md'] });
    search = createSearchService({
      store,
      cursors: createCursorCodec(randomBytes(32)),
      workerPath: fakeWorker({ delayDiagnostics: 3000 }),
    });
    // 先にindexを今の文書に合わせ、workerを動かしておく（検索はindexへの登録を待つ）。
    await search.search({ query: '本文' });
    const controller = new AbortController();
    const started = Date.now();
    const waiting = search.diagnostics(false, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
