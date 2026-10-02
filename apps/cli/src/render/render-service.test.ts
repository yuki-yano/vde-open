import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocument } from '@vde-open/document';
import { renderDocument, scanReferences } from '@vde-open/document/render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService } from '../documents/service.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs } from '../persistence/store-fs.ts';
import { createSessionService } from '../server/session-service.ts';
import type { ParseService } from '../workers/parse-service.ts';
import { createRenderService, type RenderService } from './render-service.ts';

let base: string;
let store: StateStore;
let documents: DocumentService;
let render: RenderService;
let sessionId: string;
// 表示用の変換を、合図があるまで止める。
let holdRender: Promise<void> | null;
let renderStarted: () => void;
let renders: number;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-render-')));
  store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  documents = new DocumentService({ store, cursors: createCursorCodec(randomBytes(32)) });
  const sessions = createSessionService();
  sessionId = sessions.idOf(sessions.exchange(sessions.createBootstrapTicket()) as string);
  holdRender = null;
  renderStarted = () => undefined;
  renders = 0;
  const parse: ParseService = {
    analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
    scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
    render: async (input) => {
      renders += 1;
      renderStarted();
      if (holdRender) await holdRender;
      return renderDocument(input);
    },
    close: () => Promise.resolve(),
  };
  render = createRenderService({
    store,
    documents,
    sessions,
    parse,
    previewOrigin: () => 'http://127.0.0.1:1',
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  const path = join(base, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

async function openDocument(): Promise<string> {
  write('site/index.html', '<p>本文</p>');
  const opened = await documents.open({ cwd: base, paths: ['site/index.html'] });
  return opened.data.documents[0]?.documentId as string;
}

// 表示用の変換が始まったところで止める。戻り値を呼ぶと再開する。
function pauseRender(): { started: Promise<void>; resume: () => void } {
  let resume: () => void = () => undefined;
  holdRender = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    renderStarted = resolve;
  });
  return { started, resume };
}

describe('SEC-015 表示の権限と、文書を閉じる操作の前後関係', () => {
  it('変換を待つ間に文書が閉じられたら、権限を発行しない', async () => {
    const documentId = await openDocument();
    const paused = pauseRender();
    const issuing = render.createGrant(sessionId, { documentId });
    await paused.started;

    await documents.close({ cwd: base, targets: [documentId] });
    paused.resume();
    await expect(issuing).rejects.toMatchObject({ code: 'E_DOCUMENT_NOT_OPEN' });
    expect(render.grantCount).toBe(0);
  });

  it('変換を待つ間に閉じて開き直された場合、閉じる前に始めた発行は成立しない', async () => {
    const documentId = await openDocument();
    const paused = pauseRender();
    const issuing = render.createGrant(sessionId, { documentId });
    await paused.started;

    await documents.close({ cwd: base, targets: [documentId] });
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    holdRender = null;
    paused.resume();
    // 開き直した後の文書に対して、開いていることを確かめ直してから発行する。
    const grant = await issuing;
    expect(render.grantCount).toBe(1);
    expect(await render.resolve(grant.grant, 'index.html')).not.toBeNull();

    // この権限は、開き直した後のものとして扱われる。次に閉じれば失効し、開き直しても戻らない。
    await documents.close({ cwd: base, targets: [documentId] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();
  });

  it('発行済みの権限は、閉じた時点の後始末を待たなくても、開き直した後に使えない', async () => {
    const documentId = await openDocument();
    const grant = await render.createGrant(sessionId, { documentId });
    expect(await render.resolve(grant.grant, 'index.html')).not.toBeNull();

    // 後始末（pruneClosed）を呼ばないまま、閉じて開き直す。
    await documents.close({ cwd: base, targets: [documentId] });
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();

    // 開き直した後に発行した権限は使える。
    const fresh = await render.createGrant(sessionId, { documentId });
    expect(await render.resolve(fresh.grant, 'index.html')).not.toBeNull();
  });

  it('同じ内容の文書が別の位置にあるとき、変換結果を取り違えない', async () => {
    write('site/a.html', '<p>同じ</p>');
    write('site/b.html', '<p>同じ</p>');
    const opened = await documents.open({ cwd: base, paths: ['site/a.html', 'site/b.html'] });
    const [a, b] = opened.data.documents.map((document) => document.documentId) as [string, string];
    const grantA = await render.createGrant(sessionId, { documentId: a });
    const grantB = await render.createGrant(sessionId, { documentId: b });
    expect(grantA.revision).toBe(grantB.revision);
    expect([grantA.documentLogicalPath, grantB.documentLogicalPath]).toEqual(['a.html', 'b.html']);
    expect(await render.resolve(grantB.grant, 'a.html')).toBeNull();
    expect(await render.resolve(grantB.grant, 'b.html')).not.toBeNull();
    // 同じ文書・同じ版の2回目は、変換し直さない。
    await render.createGrant(sessionId, { documentId: a });
    expect(renders).toBe(2);
  });
});
