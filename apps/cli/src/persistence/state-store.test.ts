import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DocumentRecord, StatePayload } from './state-schema.ts';
import { StateStore, type Transaction } from './state-store.ts';
import { nodeStoreFs, type StoreFs } from './store-fs.ts';

type Operation = keyof StoreFs;
type Fault = (operation: Operation, path: string) => void;

class SimulatedCrash extends Error {}

// 各file操作の直前でfaultを呼ぶ。faultが投げれば、その操作は実行されない。
function faultyFs(fault: Fault): StoreFs {
  const wrap =
    <K extends Operation>(operation: K) =>
    (...args: Parameters<StoreFs[K]>): ReturnType<StoreFs[K]> => {
      // renameは置換先のpathで判定する。
      fault(operation, (operation === 'rename' ? args[1] : args[0]) as string);
      return (nodeStoreFs[operation] as (...a: unknown[]) => ReturnType<StoreFs[K]>)(...args);
    };
  return {
    mkdir: wrap('mkdir'),
    readFile: wrap('readFile'),
    writeFileDurable: wrap('writeFileDurable'),
    rename: wrap('rename'),
    syncDirectory: wrap('syncDirectory'),
    remove: wrap('remove'),
    list: wrap('list'),
    size: wrap('size'),
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function addDocument(tx: Transaction, source: string): string {
  const documentId = `doc_${randomUUID()}`;
  const blob = tx.putBlob(Buffer.from(source, 'utf8'));
  const now = '2026-10-02T12:00:00.000Z';
  const record: DocumentRecord = {
    documentId,
    sourceKind: 'stdin',
    canonicalPath: null,
    key: null,
    format: 'markdown',
    title: 'test',
    titleExplicit: false,
    displayPath: null,
    pathSegments: [],
    isOpen: true,
    openedAt: now,
    updatedAt: now,
    sourceState: 'ready',
    currentRevision: `rev_${sha256(`rev:${source}`)}`,
    revisions: [
      {
        revision: `rev_${sha256(`rev:${source}`)}`,
        format: 'markdown',
        sourceSha256: blob,
        byteLength: Buffer.byteLength(source),
        parserProfileVersion: 'markdown-tanstack-v1',
        createdAt: now,
        documentLogicalPath: 'index.md',
        assets: [],
        assetScan: 'complete',
      },
    ],
    assetsRoot: null,
    extraAssets: [],
    htmlMode: 'static',
  };
  tx.state.documents[documentId] = record;
  tx.state.openOrder.push(documentId);
  tx.state.catalogVersion += 1;
  return documentId;
}

async function assertConsistent(root: string): Promise<StatePayload> {
  const store = await StateStore.open({ root, fs: nodeStoreFs });
  for (const record of Object.values(store.payload.documents)) {
    for (const revision of record.revisions) {
      const bytes = await store.readBlob(revision.sourceSha256);
      expect(sha256(bytes.toString('utf8'))).toBe(revision.sourceSha256);
    }
  }
  return store.payload;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vde-open-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('StateStoreの基本動作', () => {
  it('commitした内容を再起動後に復元する', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    expect(store.payload.openOrder).toEqual([]);
    const documentId = await store.transaction((tx) => addDocument(tx, '# 一つ目\n'));
    expect(store.storeVersion).toBe(1);

    const reopened = await StateStore.open({ root, fs: nodeStoreFs });
    expect(reopened.storeVersion).toBe(1);
    expect(reopened.payload).toEqual(store.payload);
    expect(reopened.payload.openOrder).toEqual([documentId]);
  });

  it('内容が変わらないtransactionはcommitしない', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await store.transaction((tx) => addDocument(tx, 'a'));
    await store.transaction(() => undefined);
    expect(store.storeVersion).toBe(1);
  });

  it('mutateが失敗したらstateを変えない', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await expect(
      store.transaction((tx) => {
        addDocument(tx, 'a');
        throw new Error('中断');
      }),
    ).rejects.toThrow('中断');
    expect(store.payload.openOrder).toEqual([]);
    expect(store.storeVersion).toBe(0);
  });

  it('同時に依頼された変更を1件ずつ順にcommitする', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.transaction((tx) => addDocument(tx, `文書 ${String(index)}`)),
      ),
    );
    expect(store.payload.openOrder).toEqual(ids);
    expect(store.storeVersion).toBe(8);
    expect((await assertConsistent(root)).openOrder).toEqual(ids);
  });

  it('直前のstateが参照するblobはGCで消さない', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    const first = await store.transaction((tx) => addDocument(tx, '残す内容'));
    await store.transaction((tx) => {
      delete tx.state.documents[first];
      tx.state.openOrder = [];
      tx.state.catalogVersion += 1;
    });
    // state.prev.jsonがまだ最初の文書を参照している。
    expect(await store.collectGarbage()).toBe(0);
    await store.transaction((tx) => {
      tx.state.catalogVersion += 1;
    });
    expect(await store.collectGarbage()).toBe(1);
    expect(readdirSync(join(root, 'blobs'))).toEqual([]);
  });
});

describe('StateStoreのclose', () => {
  it('進行中のcommitを待ち、以後の変更を受け付けない', async () => {
    let release: () => void = () => undefined;
    let block = false;
    const fs = faultyFs(() => undefined);
    const slowFs: StoreFs = {
      ...fs,
      writeFileDurable: async (path, data, mode) => {
        if (block && path.includes('.tmp-state-')) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return fs.writeFileDurable(path, data, mode);
      },
    };
    const store = await StateStore.open({ root, fs: slowFs });
    block = true;
    const pending = store.transaction((tx) => addDocument(tx, '進行中'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);

    release();
    await closing;
    const documentId = await pending;
    expect(store.payload.openOrder).toEqual([documentId]);
    await expect(store.transaction((tx) => addDocument(tx, '閉じた後'))).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });
    expect((await assertConsistent(root)).openOrder).toEqual([documentId]);
  });
});

describe('SYS-010 保存の失敗（部分検証を含む）', () => {
  it.each([
    ['blobの書込みでdisk full', 'writeFileDurable', /blobs/, 'ENOSPC'],
    ['state.prev.jsonの更新に失敗', 'rename', /state\.prev\.json$/, 'EIO'],
    ['次stateの一時fileでfsync失敗', 'writeFileDurable', /\.tmp-state-/, 'EIO'],
    ['state.jsonへのrename失敗', 'rename', /state\.json$/, 'EIO'],
  ] as const)(
    'replace前の失敗（%s）は成功を返さず、元stateのまま運転を続ける',
    async (_name, operation, pathPattern, code) => {
      let armed = false;
      const fs = faultyFs((op, path) => {
        if (armed && op === operation && pathPattern.test(path)) throw errno(code);
      });
      const store = await StateStore.open({ root, fs });
      const first = await store.transaction((tx) => addDocument(tx, '元の内容'));
      const before = readFileSync(join(root, 'state.json'));

      armed = true;
      await expect(store.transaction((tx) => addDocument(tx, '新しい内容'))).rejects.toMatchObject({
        code: 'E_STORAGE_WRITE_FAILED',
      });
      expect(store.payload.openOrder).toEqual([first]);
      expect(readFileSync(join(root, 'state.json')).equals(before)).toBe(true);
      expect(store.fatalError).toBeNull();

      armed = false;
      const second = await store.transaction((tx) => addDocument(tx, '再実行'));
      expect(store.payload.openOrder).toEqual([first, second]);
      expect((await assertConsistent(root)).openOrder).toEqual([first, second]);
    },
  );

  it('replace後のdirectory sync失敗はE_COMMIT_INDETERMINATEで、以後の書込みを止める', async () => {
    let armed = false;
    const fs = faultyFs((op, path) => {
      if (armed && op === 'syncDirectory' && path === root) throw errno('EIO');
    });
    const store = await StateStore.open({ root, fs });
    const first = await store.transaction((tx) => addDocument(tx, '元の内容'));
    const fatal: string[] = [];
    store.onFatal((error) => fatal.push(error.code));

    armed = true;
    await expect(store.transaction((tx) => addDocument(tx, '新しい内容'))).rejects.toMatchObject({
      code: 'E_COMMIT_INDETERMINATE',
      retryable: true,
    });
    // memoryは旧stateのまま。新旧どちらかへ決め打ちしない。
    expect(store.payload.openOrder).toEqual([first]);
    expect(fatal).toEqual(['E_COMMIT_INDETERMINATE']);

    armed = false;
    await expect(store.transaction((tx) => addDocument(tx, '続行'))).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });

    // 結果を保証できない状態では、memoryの旧stateを根拠にblobを消さない。
    const blobsBefore = readdirSync(join(root, 'blobs')).toSorted();
    await expect(store.collectGarbage()).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    expect(readdirSync(join(root, 'blobs')).toSorted()).toEqual(blobsBefore);

    // 再起動後はディスクの整合したstateを正とする。
    const restored = await assertConsistent(root);
    expect(restored.openOrder).toHaveLength(2);
    expect(restored.openOrder[0]).toBe(first);
  });
});

describe('SYS-009 commit途中のkill（state store単位の部分検証）', () => {
  it('どのfile操作の直前で止まっても、復元後は旧または新の整合したstateになる', async () => {
    // 障害なしで1回commitし、file操作の回数を数える。
    let operations = 0;
    const counting = faultyFs(() => {
      operations += 1;
    });
    const probeRoot = mkdtempSync(join(tmpdir(), 'vde-open-store-probe-'));
    try {
      const probe = await StateStore.open({ root: probeRoot, fs: counting });
      await probe.transaction((tx) => addDocument(tx, '元の内容'));
      operations = 0;
      await probe.transaction((tx) => addDocument(tx, '新しい内容'));
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
    expect(operations).toBeGreaterThan(5);

    const outcomes = new Set<number>();
    for (let crashAt = 1; crashAt <= operations; crashAt += 1) {
      const caseRoot = mkdtempSync(join(tmpdir(), 'vde-open-store-crash-'));
      try {
        let count = 0;
        let armed = false;
        const fs = faultyFs(() => {
          if (!armed) return;
          count += 1;
          if (count === crashAt) throw new SimulatedCrash(`操作 ${String(crashAt)} の直前で停止`);
        });
        const store = await StateStore.open({ root: caseRoot, fs });
        const first = await store.transaction((tx) => addDocument(tx, '元の内容'));
        armed = true;
        await expect(store.transaction((tx) => addDocument(tx, '新しい内容'))).rejects.toThrow();
        armed = false;

        const restored = await assertConsistent(caseRoot);
        expect(restored.openOrder[0]).toBe(first);
        expect([1, 2]).toContain(restored.openOrder.length);
        outcomes.add(restored.openOrder.length);
      } finally {
        rmSync(caseRoot, { recursive: true, force: true });
      }
    }
    // 停止位置によって、旧stateに留まる場合と新stateへ進む場合の両方がある。
    expect([...outcomes].toSorted()).toEqual([1, 2]);
  });
});

describe('SYS-011 stateの破損と未知の版', () => {
  async function seed(): Promise<Buffer> {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await store.transaction((tx) => addDocument(tx, '内容'));
    return readFileSync(join(root, 'state.json'));
  }

  it('checksumが一致しないstateでは起動を止め、fileを書き換えない', async () => {
    const original = JSON.parse((await seed()).toString('utf8')) as { payload: StatePayload };
    original.payload.catalogVersion += 100;
    const tampered = Buffer.from(JSON.stringify(original));
    writeFileSync(join(root, 'state.json'), tampered);

    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
    expect(readFileSync(join(root, 'state.json')).equals(tampered)).toBe(true);
  });

  it('JSONとして読めないstateでは起動を止める', async () => {
    await seed();
    writeFileSync(join(root, 'state.json'), '{"formatVersion":1,');
    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
  });

  it('未知のformatVersionでは起動を止め、空stateで上書きしない', async () => {
    const file = JSON.parse((await seed()).toString('utf8')) as Record<string, unknown>;
    file['formatVersion'] = 2;
    const future = Buffer.from(JSON.stringify(file));
    writeFileSync(join(root, 'state.json'), future);

    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_FORMAT_UNSUPPORTED',
    });
    expect(readFileSync(join(root, 'state.json')).equals(future)).toBe(true);
  });

  it('state.jsonが消えてstate.prev.jsonだけ残る場合、勝手に過去へ戻さない', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await store.transaction((tx) => addDocument(tx, '一つ目'));
    await store.transaction((tx) => addDocument(tx, '二つ目'));
    rmSync(join(root, 'state.json'));

    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
    expect(readdirSync(root)).toContain('state.prev.json');
    expect(readdirSync(root)).not.toContain('state.json');
  });

  it('stateが参照するblobが欠けていたら起動を止める', async () => {
    await seed();
    for (const name of readdirSync(join(root, 'blobs'))) rmSync(join(root, 'blobs', name));
    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
  });

  it('checksumはcanonical JSONに対して計算される', async () => {
    const file = JSON.parse((await seed()).toString('utf8')) as {
      formatVersion: number;
      storeVersion: number;
      checksum: string;
      payload: StatePayload;
    };
    const expected = sha256(
      canonicalJson({
        formatVersion: file.formatVersion,
        storeVersion: file.storeVersion,
        payload: file.payload,
      }),
    );
    expect(file.checksum).toBe(expected);
  });
});
