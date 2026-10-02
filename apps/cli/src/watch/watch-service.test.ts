import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import { readSourceFile, type LoadedSource } from '../documents/source-reader.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createWatchService, type WatchService } from './watch-service.ts';

let base: string;
let watcher: WatchService | null;

beforeEach(() => {
  // 監視が返すpathと比べるので、symlinkを解決したpathを使う。
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-watch-')));
  watcher = null;
});

afterEach(async () => {
  await watcher?.close();
  rmSync(base, { recursive: true, force: true });
});

async function createService(
  readSource?: (path: string) => Promise<LoadedSource>,
): Promise<{ store: StateStore; service: DocumentService }> {
  const store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  const service = new DocumentService({
    store,
    cursors: createCursorCodec(randomBytes(32)),
    ...(readSource ? { readSource } : {}),
  });
  return { store, service };
}

async function waitForText(
  service: DocumentService,
  documentId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = (await service.read({ documentId })).data.content;
    if (text === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`内容が反映されません: ${JSON.stringify(text)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('fileの状態と保存済みの内容の照合', () => {
  it('daemonが止まっている間の変更を、起動後に取り込む', async () => {
    const path = join(base, 'a.md');
    writeFileSync(path, '# 停止前\n');
    const first = await createService();
    const documentId = (await first.service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;
    await first.store.close();

    // 停止中にfileが変わる。
    writeFileSync(path, '# 停止中の変更\n');

    // 起動し直す。通知は来ないので、照合だけで気付く必要がある。
    const second = await createService();
    expect((await second.service.read({ documentId })).data.content).toBe('# 停止前\n');
    watcher = createWatchService({ documents: second.service, debounceMs: 20 });
    watcher.sync();
    await waitForText(second.service, documentId, '# 停止中の変更\n');
  });

  it('開いた直後の文書は、内容が合っていると分かっているので読み直さない', async () => {
    writeFileSync(join(base, 'a.md'), '# a\n');
    let reads = 0;
    const { service } = await createService((path) => {
      reads += 1;
      return readSourceFile(path);
    });
    await service.open({ cwd: base, paths: ['a.md'] });
    expect(reads).toBe(1);
    watcher = createWatchService({ documents: service, debounceMs: 20, fileCheckIntervalMs: 50 });
    watcher.sync();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(reads).toBe(1);
  });

  it('読み取った後に変わった内容を、処理済みとして扱わない', async () => {
    const path = join(base, 'a.md');
    writeFileSync(path, '# v1\n');
    // 2回目の読み込み（読み直し）で、内容を読み取った直後にfileが書き換わる。
    let reads = 0;
    const { service } = await createService(async (target) => {
      reads += 1;
      const loaded = await readSourceFile(target);
      if (reads === 2) writeFileSync(path, '# v3（読み取りの直後に保存）\n');
      return loaded;
    });
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    // 通知には頼らず、定期の照合だけで追従させる。
    writeFileSync(path, '# v2\n');
    const outcome = await service.refreshFromDisk(documentId);
    expect((await service.read({ documentId })).data.content).toBe('# v2\n');
    // 覚えているのは、読み取った内容（v2）に対応する状態。現在のfile（v3）とは食い違う。
    expect(outcome.signature).toBe(service.readSignature(documentId));

    watcher = createWatchService({ documents: service, debounceMs: 20, fileCheckIntervalMs: 50 });
    watcher.sync();
    await waitForText(service, documentId, '# v3（読み取りの直後に保存）\n');
  });
});
