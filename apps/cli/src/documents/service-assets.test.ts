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
// 参照の走査を、時間切れとして失敗させるか。'css'なら、文書の走査は成功させ、CSSの走査だけを失敗させる。
let scanFails: boolean | 'css';
let scans: string[];
// 走査の途中で呼ばれる。順序を制御するために使う。
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
      // 失敗するかどうかは、走査を始めた時点で決まる。
      const fails = scanFails === true || (scanFails === 'css' && kind === 'css');
      await beforeScan(kind);
      if (fails) {
        throw new VdeError('E_PARSE_FAILED', '時間内に終わりませんでした。', { reason: 'timeout' });
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

describe('参照の走査が終わらなかったとき', () => {
  it('調べ終えたassetを持つ文書は、版・asset・追っているfileを保ち、状態だけをerrorにする', async () => {
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>版1</p>');
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

    // 本文が変わったが、参照を調べられない。
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>版2</p>');
    scanFails = true;
    events = [];
    const failed = await service.refreshFromDisk(documentId);
    // assetのない版として公開しない。前の版と、変更を追うfileを保つ。
    expect(current(documentId)).toEqual({ ...before, sourceState: 'error' });
    expect(service.trackedFiles(documentId)).toEqual([css]);
    expect(failed).toEqual({ changed: true, signature: null });
    expect(events).toEqual([{ type: 'document-status', documentId, revision: before.revision }]);
    expect((await service.read({ documentId })).data.content).toContain('版1');

    // 調べられるようになったら、読み直しで追い付く。
    scanFails = false;
    expect((await service.refreshFromDisk(documentId)).changed).toBe(true);
    const recovered = current(documentId);
    expect(recovered).toMatchObject({
      assets: ['s.css'],
      assetScan: 'complete',
      sourceState: 'ready',
    });
    expect(recovered.revision).not.toBe(before.revision);
    expect((await service.read({ documentId })).data.content).toContain('版2');
  });

  it('明示的なopenでも、調べ終えたassetを持つ文書を、調べられなかった結果で置き換えない', async () => {
    write('site/index.html', '<link rel="stylesheet" href="s.css">');
    write('site/s.css', '.a{color:red}');
    const opened = await service.open({ cwd: base, paths: ['site/index.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const before = current(documentId);

    scanFails = true;
    await expect(
      service.open({ cwd: base, paths: ['site/index.html'], title: '付けた名前' }),
    ).rejects.toMatchObject({
      code: 'E_PARSE_FAILED',
      details: { problems: [{ code: 'E_PARSE_FAILED', reason: 'asset-scan-failed' }] },
    });
    expect(current(documentId)).toEqual(before);
    expect(store.payload.documents[documentId]?.title).not.toBe('付けた名前');
  });

  it('新しく開く文書は、assetなしで登録して、調べられなかったことを知らせる', async () => {
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>版1</p>');
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

    // 調べられないままでも、本文の更新は反映する（保つべきassetがない）。
    write('site/index.html', '<link rel="stylesheet" href="s.css"><p>版2</p>');
    await service.refreshFromDisk(documentId);
    expect(current(documentId)).toMatchObject({ assets: [], assetScan: 'failed' });
    expect((await service.read({ documentId })).data.content).toContain('版2');

    // 調べられるようになったら、読み直しでassetを登録する。
    scanFails = false;
    await service.refreshFromDisk(documentId);
    expect(current(documentId)).toMatchObject({ assets: ['s.css'], assetScan: 'complete' });
  });

  it('参照のない文書でも、調べ終えたかどうかを区別して記録し、変わったら通知する', async () => {
    write('site/plain.html', '<p>参照なし</p>');
    scanFails = true;
    const opened = await service.open({ cwd: base, paths: ['site/plain.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const failed = current(documentId);
    expect(failed).toMatchObject({ assets: [], assetScan: 'failed' });
    const updatedAt = store.payload.documents[documentId]?.updatedAt;

    // 調べ終えても、内容は同じなので版は変わらない。調べ終えたことだけを記録する。
    scanFails = false;
    events = [];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.refreshFromDisk(documentId);
    expect(current(documentId)).toEqual({ ...failed, assetScan: 'complete' });
    // 版が同じでも、UIが表示の注意書きを取り直せるよう、状態の更新として通知する。
    expect(events).toEqual([{ type: 'document-status', documentId, revision: failed.revision }]);
    expect(store.payload.documents[documentId]?.updatedAt).not.toBe(updatedAt);
  });

  it('CSSの走査だけが失敗したときも、追うfileと照合用の状態が食い違わない', async () => {
    const html = write('site/index.html', '<link rel="stylesheet" href="s.css"><p>本文</p>');
    write('site/s.css', '@import "t.css"; .a{color:red}');
    write('site/t.css', '.b{color:blue}');
    scanFails = 'css';
    const opened = await service.open({ cwd: base, paths: ['site/index.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    expect(opened.warnings.map((warning) => warning.code)).toEqual(['W_ASSET_SCAN_FAILED']);
    // 途中まで集めたCSSは使わない。追うfileも、照合用の状態も、文書だけにする。
    expect(current(documentId)).toMatchObject({ assets: [], assetScan: 'failed' });
    expect(service.trackedFiles(documentId)).toEqual([]);
    expect(service.readSignature(documentId)).not.toContain('|');

    // 監視の定期照合は、fileが変わっていなければ読み直さない。
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
      // fileが変われば読み直す。
      writeFileSync(html, '<link rel="stylesheet" href="s.css"><p>本文2</p>');
      const deadline = Date.now() + 5000;
      while (scans.length === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(scans.length).toBeGreaterThan(before);
    } finally {
      await watcher.close();
    }
  });

  it('同じkeyのstdinを並行して開いても、調べ終えたassetを、調べられなかった結果で置き換えない', async () => {
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

    // Aの走査を、合図があるまで止める。Aは、この後で走査に失敗する。
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

    // Bは走査に成功する。Aより後に始まり、Aの登録を待つ。
    scanFails = false;
    const b = service.open(params);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [first, second] = await Promise.allSettled([a, b]);

    // 順番どおり、Aが先に（assetなしで）登録され、Bが調べ終えた結果で更新する。
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const documentId = (second as PromiseFulfilledResult<Awaited<typeof b>>).value.data.documents[0]
      ?.documentId as string;
    expect(current(documentId)).toMatchObject({ assets: ['s.css'], assetScan: 'complete' });

    // 調べ終えた後の文書に、調べられなかった結果を重ねると、失敗する。前の版とassetは残る。
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
