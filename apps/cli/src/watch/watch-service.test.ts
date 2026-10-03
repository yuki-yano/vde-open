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
  // Use a path with symlinks resolved, since it is compared against paths the watcher reports.
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
      throw new Error(`The content was not updated: ${JSON.stringify(text)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('comparing file state with the saved content', () => {
  it('picks up changes made while the daemon was stopped after it starts', async () => {
    const path = join(base, 'a.md');
    writeFileSync(path, '# 停止前\n');
    const first = await createService();
    const documentId = (await first.service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;
    await first.store.close();

    // The file changes while stopped.
    writeFileSync(path, '# 停止中の変更\n');

    // Start again. No notification arrives, so the check alone must notice.
    const second = await createService();
    expect((await second.service.read({ documentId })).data.content).toBe('# 停止前\n');
    watcher = createWatchService({ documents: second.service, debounceMs: 20 });
    watcher.sync();
    await waitForText(second.service, documentId, '# 停止中の変更\n');
  });

  it('does not resync a document just opened, since its content is known to match', async () => {
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

  it('does not treat content changed after the read as handled', async () => {
    const path = join(base, 'a.md');
    writeFileSync(path, '# v1\n');
    // On the second read (the resync), the file is rewritten right after its content is read.
    let reads = 0;
    const { service } = await createService(async (target) => {
      reads += 1;
      const loaded = await readSourceFile(target);
      if (reads === 2) writeFileSync(path, '# v3（読み取りの直後に保存）\n');
      return loaded;
    });
    const documentId = (await service.open({ cwd: base, paths: ['a.md'] })).data.documents[0]
      ?.documentId as string;

    // Follow changes through the periodic check alone, not notifications.
    writeFileSync(path, '# v2\n');
    const outcome = await service.refreshFromDisk(documentId);
    expect((await service.read({ documentId })).data.content).toBe('# v2\n');
    // What is remembered is the state matching the content read (v2). It disagrees with the current file (v3).
    expect(outcome.signature).toBe(service.readSignature(documentId));

    watcher = createWatchService({ documents: service, debounceMs: 20, fileCheckIntervalMs: 50 });
    watcher.sync();
    await waitForText(service, documentId, '# v3（読み取りの直後に保存）\n');
  });
});
