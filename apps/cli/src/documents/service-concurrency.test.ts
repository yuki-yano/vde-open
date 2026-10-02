import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocument } from '@vde-open/document';
import { LIMITS, VdeError, type DocumentFormat } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { DocumentService, type DocumentEvent } from './service.ts';
import { readSourceFile, type LoadedSource } from './source-reader.ts';

let base: string;
let store: StateStore;
let events: DocumentEvent[];
let reads: string[];
let analyzedFormats: DocumentFormat[];
let service: DocumentService;
// 同じfileを同時に読んでいる数の最大値。
let maxConcurrentReads: number;

interface Gate {
  // 止める位置に到達したら解決する。
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}

function createGate(): Gate {
  let reach: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: () => {
      reach();
      return opened;
    },
  };
}

// 何回目の読み込みを、どこで止めるか。beforeは内容を読む前、afterは読んだ後。
let gates: Map<number, { before?: Gate; after?: Gate }>;
// 読み取った結果への割り込み。errorを投げれば、読めなかったことになる。
let afterRead: (loaded: LoadedSource, count: number) => LoadedSource;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'vde-open-concurrency-'));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  events = [];
  reads = [];
  analyzedFormats = [];
  gates = new Map();
  afterRead = (loaded) => loaded;
  maxConcurrentReads = 0;
  const active = new Map<string, number>();
  service = new DocumentService({
    store,
    cursors: createCursorCodec(randomBytes(32)),
    emit: (event) => events.push(event),
    analyze: (format, text) => {
      analyzedFormats.push(format);
      return Promise.resolve(analyzeDocument(text, format));
    },
    readSource: async (path) => {
      reads.push(path);
      const count = reads.length;
      const current = (active.get(path) ?? 0) + 1;
      active.set(path, current);
      maxConcurrentReads = Math.max(maxConcurrentReads, current);
      try {
        await gates.get(count)?.before?.wait();
        const loaded = await readSourceFile(path);
        await gates.get(count)?.after?.wait();
        return afterRead(loaded, count);
      } finally {
        active.set(path, (active.get(path) ?? 1) - 1);
      }
    },
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const write = (name: string, content: string) => {
  const path = join(base, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};

async function currentText(documentId: string): Promise<string> {
  return (await service.read({ documentId })).data.content ?? '';
}

// 次の読み込みを、内容を読む前、または読んだ後で止める。
function holdNextRead(where: 'before' | 'after'): Gate {
  const gate = createGate();
  gates.set(reads.length + 1, { [where]: gate });
  return gate;
}

// 他の処理が、待たされていなければ進めるだけの時間を置く。
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('同じfileの「読む→公開する」の順序', () => {
  it('先に始めた読み直しが後から新しい内容を読んでも、後から始めた読み直しが古い内容で上書きしない', async () => {
    write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;
    write('a.md', '# v2\n');

    // 読み直しAは、内容を読む前で止まる。
    const holdA = holdNextRead('before');
    const a = service.refreshFromDisk(documentId);
    await holdA.reached;
    // 読み直しBは、内容を読めたら、読んだ後で止まる。並行して読めるなら、ここでv2を読む。
    const holdB = createGate();
    gates.set(reads.length + 1, { after: holdB });
    const b = service.refreshFromDisk(documentId);
    await settle();

    // fileがv3になってから、Aが読んで公開する。
    write('a.md', '# v3\n');
    holdA.release();
    expect((await a).changed).toBe(true);
    expect(await currentText(documentId)).toBe('# v3\n');

    // Bが再開しても、v2へは戻らない。
    holdB.release();
    await b;
    expect(await currentText(documentId)).toBe('# v3\n');
    // 同じfileを並行して読んでいない。Bが読んだのは、Aの公開の後。
    expect(maxConcurrentReads).toBe(1);
  });

  it('読んだ後に公開が遅れても、後から始めた読み直しが先に公開することはない', async () => {
    write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    // 読み直しAが「v2」を読んだところで止まる。
    write('a.md', '# v2\n');
    const hold = holdNextRead('after');
    const slow = service.refreshFromDisk(documentId);
    await hold.reached;

    // fileがv3になり、読み直しBが始まる。BはAの公開を待つ。
    write('a.md', '# v3\n');
    const fast = service.refreshFromDisk(documentId);
    await settle();
    expect(await currentText(documentId)).toBe('# v1\n');

    hold.release();
    await Promise.all([slow, fast]);
    expect(await currentText(documentId)).toBe('# v3\n');
    expect(maxConcurrentReads).toBe(1);
    // 覚えているfileの状態は、最後に公開した内容（v3）に対応する。
    expect(service.readSignature(documentId)).toBe((await fast).signature);
  });

  it('遅れて公開された「読めない」という結果の後でも、新しい内容が最後に反映される', async () => {
    const path = write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    // 読み直しAは、fileが読めないという結果を持って止まる。
    const failing = reads.length + 1;
    afterRead = (loaded, count) => {
      if (count !== failing) return loaded;
      throw new VdeError('E_INVALID_SOURCE', '読めません。', { path, reason: 'invalid-utf8' });
    };
    const hold = holdNextRead('after');
    const slow = service.refreshFromDisk(documentId);
    await hold.reached;

    write('a.md', '# v2\n');
    const fast = service.refreshFromDisk(documentId);
    await settle();
    hold.release();
    await Promise.all([slow, fast]);
    expect(store.payload.documents[documentId]?.sourceState).toBe('ready');
    expect(await currentText(documentId)).toBe('# v2\n');
  });

  it('明示的なopenと読み直しが重なっても、後から読んだ内容が最後に反映される', async () => {
    write('a.md', '# v1\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    write('a.md', '# v2\n');
    const hold = holdNextRead('after');
    const opening = service.open({ cwd: base, paths: ['a.md'], title: '付けた名前' });
    await hold.reached;

    write('a.md', '# v3\n');
    const refreshing = service.refreshFromDisk(documentId);
    await settle();
    hold.release();
    const opened = await opening;
    await refreshing;

    // openは成功し、titleの指定も残る。本文は、後から読んだv3。
    expect(opened.data.documents[0]?.title).toBe('付けた名前');
    expect(store.payload.documents[documentId]?.title).toBe('付けた名前');
    expect(await currentText(documentId)).toBe('# v3\n');
    expect(maxConcurrentReads).toBe(1);
  });

  it('別のfileの読み直しは、互いを待たない', async () => {
    write('a.md', '# a\n');
    write('b.md', '# b\n');
    const opened = await service.open({ cwd: base, paths: ['a.md', 'b.md'] });
    const [a, b] = opened.data.documents.map((document) => document.documentId) as [string, string];

    write('a.md', '# a2\n');
    write('b.md', '# b2\n');
    const hold = holdNextRead('after');
    const slow = service.refreshFromDisk(a);
    await hold.reached;
    // aの読み直しが止まっていても、bの読み直しは終わる。
    expect((await service.refreshFromDisk(b)).changed).toBe(true);
    expect(await currentText(b)).toBe('# b2\n');
    hold.release();
    await slow;
    expect(await currentText(a)).toBe('# a2\n');
  });
});

describe('監視ruleによる新しい文書の登録', () => {
  it('走査と明示的なopenが重なっても、後から読んだ内容が最後に反映される', async () => {
    mkdirSync(join(base, 'docs'));
    const rule = (await service.open({ cwd: base, paths: ['docs'], watch: true })).data
      .watchRules[0];
    const watchId = rule?.watchId as string;

    // 走査が「v1」を読んだところで止まる。
    write('docs/b.md', '# v1\n');
    const hold = holdNextRead('after');
    const scanning = service.reconcileWatchRule(watchId);
    await hold.reached;

    // その間に、同じfileを新しい内容で明示的に開く。openは走査の公開を待つ。
    write('docs/b.md', '# v2\n');
    const opening = service.open({ cwd: base, paths: ['docs/b.md'] });
    await settle();
    hold.release();
    const added = await scanning;
    const opened = await opening;
    const documentId = opened.data.documents[0]?.documentId as string;

    expect(added).toEqual([documentId]);
    expect(await currentText(documentId)).toBe('# v2\n');
    expect(maxConcurrentReads).toBe(1);
    // 走査での登録と、openでの更新の、どちらも通知されている。
    expect(events.map((event) => event.type)).toEqual(['catalog-changed', 'document-changed']);
  });

  it('走査が順番を待つ間に明示的に開かれた文書は、読まず、触れない', async () => {
    mkdirSync(join(base, 'docs'));
    const rule = (await service.open({ cwd: base, paths: ['docs'], watch: true })).data
      .watchRules[0];
    const watchId = rule?.watchId as string;

    // 明示的なopenが「v1」を読んだところで止まる。まだ登録されていない。
    write('docs/b.md', '# v1\n');
    const hold = holdNextRead('after');
    const opening = service.open({ cwd: base, paths: ['docs/b.md'] });
    await hold.reached;

    // 走査は、このfileを新しい文書の候補として見つけ、openの公開を待つ。
    const scanning = service.reconcileWatchRule(watchId);
    await settle();
    hold.release();
    const opened = await opening;
    const versionAfterOpen = store.payload.catalogVersion;
    const eventsAfterOpen = events.length;

    expect(await scanning).toEqual([]);
    // 走査は本文を読んでいない。状態も通知も変わらない。
    expect(reads.filter((path) => path.endsWith('b.md'))).toHaveLength(1);
    expect(store.payload.catalogVersion).toBe(versionAfterOpen);
    expect(events).toHaveLength(eventsAfterOpen);
    expect(await currentText(opened.data.documents[0]?.documentId as string)).toBe('# v1\n');
  });

  it('件数の上限を超える候補は、本文を1件も読まずに拒否する', async () => {
    mkdirSync(join(base, 'many'));
    const rule = (await service.open({ cwd: base, paths: ['many'], watch: true })).data
      .watchRules[0];
    for (let index = 0; index <= LIMITS.openDocuments; index += 1) {
      writeFileSync(join(base, 'many', `${String(index)}.md`), '# x\n');
    }
    reads = [];
    await expect(service.reconcileWatchRule(rule?.watchId as string)).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'openDocuments' },
    });
    expect(reads).toEqual([]);
    expect(store.payload.openOrder).toEqual([]);
  });

  it('合計の大きさの上限に達したら、残りの候補を読まない', async () => {
    mkdirSync(join(base, 'big'));
    const rule = (await service.open({ cwd: base, paths: ['big'], watch: true })).data
      .watchRules[0];
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(base, 'big', `${String(index)}.md`), '# x\n');
    }
    // 1件を上限いっぱいの大きさとして扱う。実際のfileは小さいままにして、読み込みの回数だけを見る。
    const large = Buffer.alloc(LIMITS.documentBytes);
    afterRead = (loaded) => ({ ...loaded, bytes: large });
    reads = [];
    await expect(service.reconcileWatchRule(rule?.watchId as string)).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'openSourceBytes' },
    });
    // 128MiBを超えた時点（13件目）で止まる。20件すべては読まない。
    expect(reads).toHaveLength(Math.floor(LIMITS.openSourceBytes / LIMITS.documentBytes) + 1);
    expect(store.payload.openOrder).toEqual([]);
  });
});

describe('本文以外の変更の通知', () => {
  it('titleだけを変えたときも通知する', async () => {
    write('a.md', '# a\n');
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;
    events = [];
    const renamed = await service.open({ cwd: base, paths: ['a.md'], title: '新しい名前' });
    expect(renamed.data.updated).toBe(1);
    expect(events).toEqual([
      { type: 'document-status', documentId, revision: renamed.data.documents[0]?.revision },
    ]);

    // 何も変わらないopenでは通知しない。
    events = [];
    await service.open({ cwd: base, paths: ['a.md'], title: '新しい名前' });
    expect(events).toEqual([]);
  });

  it('同じ内容のまま読めない状態から回復したときも通知する', async () => {
    const path = write('a.md', '# a\n');
    const opened = await service.open({ cwd: base, paths: ['a.md'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const revision = opened.data.documents[0]?.revision as string;

    afterRead = () => {
      throw new VdeError('E_INVALID_SOURCE', '読めません。', { path, reason: 'invalid-utf8' });
    };
    events = [];
    await service.refreshFromDisk(documentId);
    expect(store.payload.documents[documentId]?.sourceState).toBe('error');
    expect(events).toEqual([{ type: 'document-status', documentId, revision }]);

    // 読み直しでの回復。
    afterRead = (loaded) => loaded;
    events = [];
    expect((await service.refreshFromDisk(documentId)).changed).toBe(true);
    expect(store.payload.documents[documentId]?.sourceState).toBe('ready');
    expect(events).toEqual([{ type: 'document-status', documentId, revision }]);

    // 明示的なopenでの回復。
    afterRead = () => {
      throw new VdeError('E_INVALID_SOURCE', '読めません。', { path, reason: 'invalid-utf8' });
    };
    await service.refreshFromDisk(documentId);
    afterRead = (loaded) => loaded;
    events = [];
    await service.open({ cwd: base, paths: ['a.md'] });
    expect(store.payload.documents[documentId]?.sourceState).toBe('ready');
    expect(events).toEqual([{ type: 'document-status', documentId, revision }]);
  });

  it('並び順が変わらないreorderでは通知しない', async () => {
    write('a.md', '# a\n');
    const opened = await service.open({ cwd: base, paths: ['a.md'] });
    events = [];
    await service.reorder({
      order: [opened.data.documents[0]?.documentId as string],
      expectedCatalogVersion: opened.catalogVersion,
    });
    expect(events).toEqual([]);
  });
});

describe('形式を変えて開き直した文書の、前の版', () => {
  it('前の版の見出しは、その版を作ったときの形式で解析する', async () => {
    write('a.md', '# Markdownの見出し\n\n<h2>HTMLの見出し</h2>\n');
    const asMarkdown = await service.open({ cwd: base, paths: ['a.md'] });
    const documentId = asMarkdown.data.documents[0]?.documentId as string;
    const markdownRevision = asMarkdown.data.documents[0]?.revision as string;

    const asHtml = await service.open({ cwd: base, paths: ['a.md'], format: 'html' });
    const htmlRevision = asHtml.data.documents[0]?.revision as string;
    expect(htmlRevision).not.toBe(markdownRevision);

    // 解析結果がまだない状態で、前の版を取得する。
    const first = await service.read({ documentId, outline: true, revision: markdownRevision });
    expect(first.data.extraction).toBe('markdown');
    expect(first.data.outline?.map((item) => item.title)).toEqual(['Markdownの見出し']);
    // 解析結果を保持した後も同じ。
    const second = await service.read({ documentId, outline: true, revision: markdownRevision });
    expect(second.data.extraction).toBe('markdown');
    expect(second.data.outline?.map((item) => item.title)).toEqual(['Markdownの見出し']);

    const current = await service.read({ documentId, outline: true });
    expect(current.data.revision).toBe(htmlRevision);
    expect(current.data.extraction).toBe('static-html');
    expect(current.data.outline?.map((item) => item.title)).toEqual(['HTMLの見出し']);
    expect(analyzedFormats).toEqual(['markdown', 'html']);
  });
});
