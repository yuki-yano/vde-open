import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanReferences } from '@vde-open/document/render';
import { VdeError } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createCursorCodec } from './cursor.ts';
import { DocumentService, type DocumentEvent } from './service.ts';

let base: string;
let store: StateStore;
let service: DocumentService;
let events: DocumentEvent[];
// Whether the reference scan fails with a timeout. 'css' makes only the CSS scan fail while the document scan succeeds.
let scanFails: boolean | 'css';
let scans: string[];
// Called during the scan. Used to control ordering.
let beforeScan: (kind: string) => Promise<void>;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-assets-')));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  events = [];
  scanFails = false;
  scans = [];
  beforeScan = () => Promise.resolve();
  service = new DocumentService({
    store,
    cursors: createCursorCodec(randomBytes(32)),
    emit: (event) => events.push(event),
    scan: async (kind, text) => {
      scans.push(kind);
      // Whether it fails is decided when the scan starts.
      const fails = scanFails === true || (scanFails === 'css' && kind === 'css');
      await beforeScan(kind);
      if (fails) {
        throw new VdeError('E_PARSE_FAILED', 'Did not finish in time.', { reason: 'timeout' });
      }
      return scanReferences(kind, text);
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

const current = (documentId: string) => {
  const record = store.payload.documents[documentId];
  const entry = record?.revisions.find((revision) => revision.revision === record.currentRevision);
  return {
    revision: record?.currentRevision,
    sourceState: record?.sourceState,
    assets: entry?.assets.map((asset) => asset.logicalPath),
    assetScan: entry?.assetScan,
  };
};

describe('when the reference scan does not finish', () => {
  it('a document with fully scanned assets keeps its revision, assets, and tracked files, and only its status becomes error', async () => {
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>Version 1</p>');
    const css = write('site/s.css', '.a{color:red}');
    const opened = await service.open({ cwd: base, paths: ['site/index.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const before = current(documentId);
    expect(before).toMatchObject({
      assets: ['s.css'],
      assetScan: 'complete',
      sourceState: 'ready',
    });
    expect(service.trackedFiles(documentId)).toEqual([css]);

    // The content changed, but the references cannot be scanned.
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>Version 2</p>');
    scanFails = true;
    events = [];
    const failed = await service.refreshFromDisk(documentId);
    // Not published as a revision without assets. The previous revision and tracked files are kept.
    expect(current(documentId)).toEqual({ ...before, sourceState: 'error' });
    expect(service.trackedFiles(documentId)).toEqual([css]);
    expect(failed).toEqual({ changed: true, signature: null });
    expect(events).toEqual([{ type: 'document-status', documentId, revision: before.revision }]);
    expect((await service.read({ documentId })).data.content).toContain('Version 1');

    // Once scanning works again, a refresh catches up.
    scanFails = false;
    expect((await service.refreshFromDisk(documentId)).changed).toBe(true);
    const recovered = current(documentId);
    expect(recovered).toMatchObject({
      assets: ['s.css'],
      assetScan: 'complete',
      sourceState: 'ready',
    });
    expect(recovered.revision).not.toBe(before.revision);
    expect((await service.read({ documentId })).data.content).toContain('Version 2');
  });

  it('an explicit open does not replace a document with fully scanned assets by a failed scan result either', async () => {
    write('site/index.html', '<link rel="stylesheet" href="s.css">');
    write('site/s.css', '.a{color:red}');
    const opened = await service.open({ cwd: base, paths: ['site/index.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const before = current(documentId);

    scanFails = true;
    await expect(
      service.open({ cwd: base, paths: ['site/index.html'], title: 'Given title' }),
    ).rejects.toMatchObject({
      code: 'E_PARSE_FAILED',
      details: { problems: [{ code: 'E_PARSE_FAILED', reason: 'asset-scan-failed' }] },
    });
    expect(current(documentId)).toEqual(before);
    expect(store.payload.documents[documentId]?.title).not.toBe('Given title');
  });

  it('a newly opened document is registered without assets and the failed scan is reported', async () => {
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>Version 1</p>');
    write('site/s.css', '.a{color:red}');
    scanFails = true;
    const opened = await service.open({ cwd: base, paths: ['site/index.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    expect(opened.warnings.map((warning) => warning.code)).toEqual(['W_ASSET_SCAN_FAILED']);
    expect(current(documentId)).toMatchObject({
      assets: [],
      assetScan: 'failed',
      sourceState: 'ready',
    });

    // Content updates are applied even while scanning fails (there are no assets to keep).
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>Version 2</p>');
    await service.refreshFromDisk(documentId);
    expect(current(documentId)).toMatchObject({ assets: [], assetScan: 'failed' });
    expect((await service.read({ documentId })).data.content).toContain('Version 2');

    // Once scanning works again, a refresh registers the assets.
    scanFails = false;
    await service.refreshFromDisk(documentId);
    expect(current(documentId)).toMatchObject({ assets: ['s.css'], assetScan: 'complete' });
  });

  it('even for a document with no references, whether the scan completed is recorded and changes are notified', async () => {
    write('site/plain.html', '<p>No references</p>');
    scanFails = true;
    const opened = await service.open({ cwd: base, paths: ['site/plain.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const failed = current(documentId);
    expect(failed).toMatchObject({ assets: [], assetScan: 'failed' });
    const updatedAt = store.payload.documents[documentId]?.updatedAt;

    // The scan completes, but the content is the same so the revision is unchanged. Only the completion is recorded.
    scanFails = false;
    events = [];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.refreshFromDisk(documentId);
    expect(current(documentId)).toEqual({ ...failed, assetScan: 'complete' });
    // Even with the same revision, notify as a status update so the UI can refresh the view notice.
    expect(events).toEqual([{ type: 'document-status', documentId, revision: failed.revision }]);
    expect(store.payload.documents[documentId]?.updatedAt).not.toBe(updatedAt);
  });

  it('when only the CSS scan fails, tracked files and the comparison state stay consistent', async () => {
    const html = write('site/index.html', '<link rel="stylesheet" href="s.css"><p>Body</p>');
    write('site/s.css', '@import "t.css"; .a{color:red}');
    write('site/t.css', '.b{color:blue}');
    scanFails = 'css';
    const opened = await service.open({ cwd: base, paths: ['site/index.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    expect(opened.warnings.map((warning) => warning.code)).toEqual(['W_ASSET_SCAN_FAILED']);
    // Partially collected CSS is not used. Both the tracked files and the comparison state cover only the document.
    expect(current(documentId)).toMatchObject({ assets: [], assetScan: 'failed' });
    expect(service.trackedFiles(documentId)).toEqual([]);
    expect(service.readSignature(documentId)).not.toContain('|');

    // The periodic watch check does not re-read unless the file changed.
    const { createWatchService } = await import('../watch/watch-service.ts');
    const watcher = createWatchService({
      documents: service,
      debounceMs: 10,
      fileCheckIntervalMs: 30,
    });
    try {
      watcher.sync();
      const before = scans.length;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(scans.length).toBe(before);
      // A file change triggers a re-read.
      writeFileSync(html, '<link rel="stylesheet" href="s.css"><p>Body 2</p>');
      const deadline = Date.now() + 5000;
      while (scans.length === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(scans.length).toBeGreaterThan(before);
    } finally {
      await watcher.close();
    }
  });

  it('concurrent stdin opens with the same key do not replace fully scanned assets by a failed scan result', async () => {
    write('site/s.css', '.a{color:red}');
    const html = '<link rel="stylesheet" href="s.css"><p>stdin</p>';
    const params = {
      cwd: base,
      paths: [],
      stdin: { content: html },
      format: 'html' as const,
      key: 'k',
      assetsRoot: 'site',
    };

    // Hold A's scan until signalled. A then fails the scan.
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    beforeScan = async () => {
      if (held) return;
      held = true;
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    scanFails = true;
    const a = service.open(params);
    await started;

    // B's scan succeeds. It starts after A and waits for A's registration.
    scanFails = false;
    const b = service.open(params);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [first, second] = await Promise.allSettled([a, b]);

    // In order: A is registered first (without assets), then B updates with the fully scanned result.
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const documentId = (second as PromiseFulfilledResult<Awaited<typeof b>>).value.data.documents[0]
      ?.documentId as string;
    expect(current(documentId)).toMatchObject({ assets: ['s.css'], assetScan: 'complete' });

    // Applying a failed scan result over a fully scanned document fails. The previous revision and assets remain.
    const before = current(documentId);
    scanFails = true;
    beforeScan = () => Promise.resolve();
    await expect(service.open(params)).rejects.toMatchObject({
      code: 'E_PARSE_FAILED',
      details: { reason: 'asset-scan-failed' },
    });
    expect(current(documentId)).toEqual(before);
  });
});
