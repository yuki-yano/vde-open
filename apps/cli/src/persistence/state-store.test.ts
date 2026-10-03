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

// Calls fault right before each file operation. If fault throws, the operation is not performed.
function faultyFs(fault: Fault): StoreFs {
  const wrap =
    <K extends Operation>(operation: K) =>
    (...args: Parameters<StoreFs[K]>): ReturnType<StoreFs[K]> => {
      // rename is judged by the destination path.
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

describe('StateStore basics', () => {
  it('restores committed content after a restart', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    expect(store.payload.openOrder).toEqual([]);
    const documentId = await store.transaction((tx) => addDocument(tx, '# first\n'));
    expect(store.storeVersion).toBe(1);

    const reopened = await StateStore.open({ root, fs: nodeStoreFs });
    expect(reopened.storeVersion).toBe(1);
    expect(reopened.payload).toEqual(store.payload);
    expect(reopened.payload.openOrder).toEqual([documentId]);
  });

  it('does not commit a transaction that changes nothing', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await store.transaction((tx) => addDocument(tx, 'a'));
    await store.transaction(() => undefined);
    expect(store.storeVersion).toBe(1);
  });

  it('leaves the state unchanged when mutate fails', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await expect(
      store.transaction((tx) => {
        addDocument(tx, 'a');
        throw new Error('aborted');
      }),
    ).rejects.toThrow('aborted');
    expect(store.payload.openOrder).toEqual([]);
    expect(store.storeVersion).toBe(0);
  });

  it('commits concurrently requested changes one at a time in order', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.transaction((tx) => addDocument(tx, `document ${String(index)}`)),
      ),
    );
    expect(store.payload.openOrder).toEqual(ids);
    expect(store.storeVersion).toBe(8);
    expect((await assertConsistent(root)).openOrder).toEqual(ids);
  });

  it('GC keeps blobs referenced by the previous state', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    const first = await store.transaction((tx) => addDocument(tx, 'kept content'));
    await store.transaction((tx) => {
      delete tx.state.documents[first];
      tx.state.openOrder = [];
      tx.state.catalogVersion += 1;
    });
    // state.prev.json still references the first document.
    expect(await store.collectGarbage()).toBe(0);
    await store.transaction((tx) => {
      tx.state.catalogVersion += 1;
    });
    expect(await store.collectGarbage()).toBe(1);
    expect(readdirSync(join(root, 'blobs'))).toEqual([]);
  });
});

describe('StateStore close', () => {
  it('waits for the in-progress commit and rejects further changes', async () => {
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
    const pending = store.transaction((tx) => addDocument(tx, 'in progress'));
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
    await expect(store.transaction((tx) => addDocument(tx, 'after close'))).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });
    expect((await assertConsistent(root)).openOrder).toEqual([documentId]);
  });
});

describe('SYS-010 save failures (including partial verification)', () => {
  it.each([
    ['disk full while writing a blob', 'writeFileDurable', /blobs/, 'ENOSPC'],
    ['failure updating state.prev.json', 'rename', /state\.prev\.json$/, 'EIO'],
    ['fsync failure on the next state temporary file', 'writeFileDurable', /\.tmp-state-/, 'EIO'],
    ['rename failure onto state.json', 'rename', /state\.json$/, 'EIO'],
  ] as const)(
    'a failure before the replace (%s) does not report success and keeps running on the original state',
    async (_name, operation, pathPattern, code) => {
      let armed = false;
      const fs = faultyFs((op, path) => {
        if (armed && op === operation && pathPattern.test(path)) throw errno(code);
      });
      const store = await StateStore.open({ root, fs });
      const first = await store.transaction((tx) => addDocument(tx, 'original'));
      const before = readFileSync(join(root, 'state.json'));

      armed = true;
      await expect(store.transaction((tx) => addDocument(tx, 'changed'))).rejects.toMatchObject({
        code: 'E_STORAGE_WRITE_FAILED',
      });
      expect(store.payload.openOrder).toEqual([first]);
      expect(readFileSync(join(root, 'state.json')).equals(before)).toBe(true);
      expect(store.fatalError).toBeNull();

      armed = false;
      const second = await store.transaction((tx) => addDocument(tx, 'retry'));
      expect(store.payload.openOrder).toEqual([first, second]);
      expect((await assertConsistent(root)).openOrder).toEqual([first, second]);
    },
  );

  it('a directory sync failure after the replace is E_COMMIT_INDETERMINATE and stops further writes', async () => {
    let armed = false;
    const fs = faultyFs((op, path) => {
      if (armed && op === 'syncDirectory' && path === root) throw errno('EIO');
    });
    const store = await StateStore.open({ root, fs });
    const first = await store.transaction((tx) => addDocument(tx, 'original'));
    const fatal: string[] = [];
    store.onFatal((error) => fatal.push(error.code));

    armed = true;
    await expect(store.transaction((tx) => addDocument(tx, 'changed'))).rejects.toMatchObject({
      code: 'E_COMMIT_INDETERMINATE',
      retryable: true,
    });
    // Memory stays on the old state. It is not committed to either old or new.
    expect(store.payload.openOrder).toEqual([first]);
    expect(fatal).toEqual(['E_COMMIT_INDETERMINATE']);

    armed = false;
    await expect(store.transaction((tx) => addDocument(tx, 'continue'))).rejects.toMatchObject({
      code: 'E_DAEMON_STOPPING',
    });

    // When the outcome cannot be guaranteed, blobs are not deleted based on the old in-memory state.
    const blobsBefore = readdirSync(join(root, 'blobs')).toSorted();
    await expect(store.collectGarbage()).rejects.toMatchObject({ code: 'E_DAEMON_STOPPING' });
    expect(readdirSync(join(root, 'blobs')).toSorted()).toEqual(blobsBefore);

    // After a restart, the consistent state on disk is authoritative.
    const restored = await assertConsistent(root);
    expect(restored.openOrder).toHaveLength(2);
    expect(restored.openOrder[0]).toBe(first);
  });
});

describe('SYS-009 kill during commit (partial verification at the state store level)', () => {
  it('whichever file operation it stops before, the restored state is consistent and either old or new', async () => {
    // Commit once without faults and count the file operations.
    let operations = 0;
    const counting = faultyFs(() => {
      operations += 1;
    });
    const probeRoot = mkdtempSync(join(tmpdir(), 'vde-open-store-probe-'));
    try {
      const probe = await StateStore.open({ root: probeRoot, fs: counting });
      await probe.transaction((tx) => addDocument(tx, 'original'));
      operations = 0;
      await probe.transaction((tx) => addDocument(tx, 'changed'));
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
          if (count === crashAt)
            throw new SimulatedCrash(`stopped right before operation ${String(crashAt)}`);
        });
        const store = await StateStore.open({ root: caseRoot, fs });
        const first = await store.transaction((tx) => addDocument(tx, 'original'));
        armed = true;
        await expect(store.transaction((tx) => addDocument(tx, 'changed'))).rejects.toThrow();
        armed = false;

        const restored = await assertConsistent(caseRoot);
        expect(restored.openOrder[0]).toBe(first);
        expect([1, 2]).toContain(restored.openOrder.length);
        outcomes.add(restored.openOrder.length);
      } finally {
        rmSync(caseRoot, { recursive: true, force: true });
      }
    }
    // Depending on where it stops, it either stays on the old state or advances to the new one.
    expect([...outcomes].toSorted()).toEqual([1, 2]);
  });
});

describe('SYS-011 state corruption and unknown versions', () => {
  async function seed(): Promise<Buffer> {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await store.transaction((tx) => addDocument(tx, 'content'));
    return readFileSync(join(root, 'state.json'));
  }

  it('refuses to start on a checksum mismatch and does not rewrite the file', async () => {
    const original = JSON.parse((await seed()).toString('utf8')) as { payload: StatePayload };
    original.payload.catalogVersion += 100;
    const tampered = Buffer.from(JSON.stringify(original));
    writeFileSync(join(root, 'state.json'), tampered);

    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
    expect(readFileSync(join(root, 'state.json')).equals(tampered)).toBe(true);
  });

  it('refuses to start when the state is not valid JSON', async () => {
    await seed();
    writeFileSync(join(root, 'state.json'), '{"formatVersion":1,');
    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
  });

  it('refuses to start on an unknown formatVersion and does not overwrite with an empty state', async () => {
    const file = JSON.parse((await seed()).toString('utf8')) as Record<string, unknown>;
    file['formatVersion'] = 2;
    const future = Buffer.from(JSON.stringify(file));
    writeFileSync(join(root, 'state.json'), future);

    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_FORMAT_UNSUPPORTED',
    });
    expect(readFileSync(join(root, 'state.json')).equals(future)).toBe(true);
  });

  it('does not roll back on its own when only state.prev.json remains after state.json is lost', async () => {
    const store = await StateStore.open({ root, fs: nodeStoreFs });
    await store.transaction((tx) => addDocument(tx, 'first'));
    await store.transaction((tx) => addDocument(tx, 'second'));
    rmSync(join(root, 'state.json'));

    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
    expect(readdirSync(root)).toContain('state.prev.json');
    expect(readdirSync(root)).not.toContain('state.json');
  });

  it('refuses to start when a blob referenced by the state is missing', async () => {
    await seed();
    for (const name of readdirSync(join(root, 'blobs'))) rmSync(join(root, 'blobs', name));
    await expect(StateStore.open({ root, fs: nodeStoreFs })).rejects.toMatchObject({
      code: 'E_STATE_CORRUPT',
    });
  });

  it('computes the checksum over canonical JSON', async () => {
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
