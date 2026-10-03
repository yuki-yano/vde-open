import { randomBytes, randomUUID } from 'node:crypto';
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

const GRANT_CONTEXT = { origin: 'http://127.0.0.1:1' };

describe('SEC-015 表示の権限と、文書を閉じる操作の前後関係', () => {
  it('変換を待つ間に文書が閉じられたら、権限を発行しない', async () => {
    const documentId = await openDocument();
    const paused = pauseRender();
    const issuing = render.createGrant(sessionId, { documentId }, GRANT_CONTEXT);
    await paused.started;

    await documents.close({ cwd: base, targets: [documentId] });
    paused.resume();
    await expect(issuing).rejects.toMatchObject({ code: 'E_DOCUMENT_NOT_OPEN' });
    expect(render.grantCount).toBe(0);
  });

  it('変換を待つ間に閉じて開き直された場合、閉じる前に始めた発行は成立しない', async () => {
    const documentId = await openDocument();
    const paused = pauseRender();
    const issuing = render.createGrant(sessionId, { documentId }, GRANT_CONTEXT);
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
    const grant = await render.createGrant(sessionId, { documentId }, GRANT_CONTEXT);
    expect(await render.resolve(grant.grant, 'index.html')).not.toBeNull();

    // 後始末（pruneClosed）を呼ばないまま、閉じて開き直す。
    await documents.close({ cwd: base, targets: [documentId] });
    await documents.open({ cwd: base, paths: ['site/index.html'] });
    expect(await render.resolve(grant.grant, 'index.html')).toBeNull();

    // 開き直した後に発行した権限は使える。
    const fresh = await render.createGrant(sessionId, { documentId }, GRANT_CONTEXT);
    expect(await render.resolve(fresh.grant, 'index.html')).not.toBeNull();
  });

  it('同じ内容の文書が別の位置にあるとき、変換結果を取り違えない', async () => {
    write('site/a.html', '<p>同じ</p>');
    write('site/b.html', '<p>同じ</p>');
    const opened = await documents.open({ cwd: base, paths: ['site/a.html', 'site/b.html'] });
    const [a, b] = opened.data.documents.map((document) => document.documentId) as [string, string];
    const grantA = await render.createGrant(sessionId, { documentId: a }, GRANT_CONTEXT);
    const grantB = await render.createGrant(sessionId, { documentId: b }, GRANT_CONTEXT);
    expect(grantA.revision).toBe(grantB.revision);
    expect([grantA.documentLogicalPath, grantB.documentLogicalPath]).toEqual(['a.html', 'b.html']);
    expect(await render.resolve(grantB.grant, 'a.html')).toBeNull();
    expect(await render.resolve(grantB.grant, 'b.html')).not.toBeNull();
    // 同じ文書・同じ版の2回目は、変換し直さない。
    await render.createGrant(sessionId, { documentId: a }, GRANT_CONTEXT);
    expect(renders).toBe(2);
  });
});

describe('interactive（scriptを動かす表示）とHTMLとの通信', () => {
  const questionnaire = JSON.stringify({
    schemaVersion: 1,
    title: '確認',
    fieldOrder: ['ok'],
    answerSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean', title: 'よい' } },
      required: [],
      additionalProperties: false,
    },
  });

  async function openInteractive(): Promise<string> {
    write('site/app.html', '<p id="x">本文</p><script>document.title = "動いた"</script>');
    const opened = await documents.open({
      cwd: base,
      paths: ['site/app.html'],
      htmlMode: 'interactive',
    });
    return opened.data.documents[0]?.documentId as string;
  }

  async function ask(documentId: string) {
    const { FeedbackService } = await import('../feedback/service.ts');
    const feedback = new FeedbackService({ store, documents });
    return (await feedback.create({ cwd: base, questionnaire, documentId })).data.request;
  }

  const body = async (grant: string, path: string) =>
    (await render.resolve(grant, path))?.body.toString('utf8') ?? null;

  it('scriptの実行を許可していない文書は、interactiveの表示を発行しない', async () => {
    const documentId = await openDocument();
    await expect(
      render.createGrant(sessionId, { documentId, mode: 'interactive' }, GRANT_CONTEXT),
    ).rejects.toMatchObject({ code: 'E_INTERACTIVE_NOT_ALLOWED' });
  });

  it('interactiveの表示はscriptを残し、SDKはinteractiveで作った回答待ちの質問の表示にだけ入れる', async () => {
    const documentId = await openInteractive();
    const plain = await render.createGrant(
      sessionId,
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    expect(plain.bridge).toBeNull();
    const plainHtml = await body(plain.grant, plain.documentLogicalPath);
    expect(plainHtml).toContain('<script>document.title');
    expect(plainHtml).not.toContain('vde-bridge-hello');
    expect((await render.resolve(plain.grant, plain.documentLogicalPath))?.mode).toBe(
      'interactive',
    );

    const request = await ask(documentId);
    const bridged = await render.createGrantForRequest(sessionId, request.requestId, GRANT_CONTEXT);
    expect(bridged).toMatchObject({ mode: 'interactive', revision: request.revision });
    expect(bridged.bridge).toEqual({
      instanceId: expect.any(String),
      requestId: request.requestId,
    });
    const html = await body(bridged.grant, bridged.documentLogicalPath);
    // SDKは最初のscriptで、表示ごとの設定（識別子と、通信してよい親のorigin）だけを持つ。
    expect(html?.indexOf('vde-bridge-hello')).toBeLessThan(html?.indexOf('document.title') ?? 0);
    expect(html).toContain(
      JSON.stringify({
        instanceId: bridged.bridge?.instanceId,
        parentOrigin: GRANT_CONTEXT.origin,
      }),
    );
    expect(html).not.toContain('__vde_bridge_config_');
    // 文書の表示の発行には、質問を指定できない。
    await expect(
      render.createGrant(sessionId, { documentId, requestId: request.requestId }, GRANT_CONTEXT),
    ).rejects.toThrow();
  });

  it('質問の表示は、質問が固定した版と表示方法で発行する。staticで作った質問は、後から許可してもscriptを動かさない', async () => {
    write('site/app.html', '<p>版1</p><script>1</script>');
    const opened = await documents.open({ cwd: base, paths: ['site/app.html'] });
    const documentId = opened.data.documents[0]?.documentId as string;
    const staticRequest = await ask(documentId);
    await documents.open({ cwd: base, paths: ['site/app.html'], htmlMode: 'interactive' });
    expect(documents.interactiveAllowed(documentId)).toBe(true);
    const pinned = await render.createGrantForRequest(
      sessionId,
      staticRequest.requestId,
      GRANT_CONTEXT,
    );
    expect(pinned).toMatchObject({ mode: 'static', bridge: null });
    expect(await body(pinned.grant, pinned.documentLogicalPath)).not.toContain('<script');

    // interactiveで作った質問も、許可が外れれば静的表示（SDKなし）。新しい版ができても、質問の版を表示する。
    const { FeedbackService } = await import('../feedback/service.ts');
    await new FeedbackService({ store, documents }).cancel(
      { requestId: staticRequest.requestId },
      'agent',
    );
    const interactiveRequest = await ask(documentId);
    write('site/app.html', '<p>版2</p>');
    await documents.open({ cwd: base, paths: ['site/app.html'] });
    await documents.setHtmlMode({ documentId, mode: 'static' });
    const revoked = await render.createGrantForRequest(
      sessionId,
      interactiveRequest.requestId,
      GRANT_CONTEXT,
    );
    expect(revoked).toMatchObject({
      mode: 'static',
      bridge: null,
      revision: interactiveRequest.revision,
    });
    expect(await body(revoked.grant, revoked.documentLogicalPath)).toContain('版1');
  });

  it('許可を外した後に許可し直しても、前の許可で発行したinteractiveの表示は戻らない', async () => {
    const documentId = await openInteractive();
    const grant = await render.createGrant(
      sessionId,
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    expect(await body(grant.grant, grant.documentLogicalPath)).not.toBeNull();
    // 外した後、前の表示には触れないまま、許可し直す。
    await documents.setHtmlMode({ documentId, mode: 'static' });
    await documents.setHtmlMode({ documentId, mode: 'interactive', confirmed: true });
    expect(await render.resolve(grant.grant, grant.documentLogicalPath)).toBeNull();
    // 許可済みのまま同じ指定で開き直しても、発行済みの表示は使い続けられる。
    const current = await render.createGrant(
      sessionId,
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    await documents.open({ cwd: base, paths: ['site/app.html'], htmlMode: 'interactive' });
    expect(await body(current.grant, current.documentLogicalPath)).not.toBeNull();
  });

  it('SDKを入れた表示の操作は、権限が有効で、発行したsessionのもので、質問が回答待ちの間だけ', async () => {
    const documentId = await openInteractive();
    const request = await ask(documentId);
    const bridged = await render.createGrantForRequest(sessionId, request.requestId, GRANT_CONTEXT);
    expect(render.bridgeOf(sessionId, bridged.grant)).toEqual({
      requestId: request.requestId,
      documentId,
      revision: request.revision,
    });
    expect(render.bridgeOf('session_other', bridged.grant)).toBeNull();
    // SDKのない表示では使えない。
    const plain = await render.createGrant(
      sessionId,
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    expect(render.bridgeOf(sessionId, plain.grant)).toBeNull();
    // 返却した権限は使えない。
    render.release(sessionId, [bridged.grant]);
    expect(render.bridgeOf(sessionId, bridged.grant)).toBeNull();
    // 質問が終われば使えない。
    const again = await render.createGrantForRequest(sessionId, request.requestId, GRANT_CONTEXT);
    const { FeedbackService } = await import('../feedback/service.ts');
    await new FeedbackService({ store, documents }).cancel(
      { requestId: request.requestId },
      'agent',
    );
    expect(render.bridgeOf(sessionId, again.grant)).toBeNull();
    await expect(
      render.createGrantForRequest(sessionId, request.requestId, GRANT_CONTEXT),
    ).rejects.toMatchObject({ code: 'E_REQUEST_NOT_PENDING' });
  });

  it.each(['cancel', 'submit', 'forget'] as const)(
    '変換を待つ間に質問が終わったら（%s）、SDKを入れた表示を発行しない',
    async (ending) => {
      const documentId = await openInteractive();
      const request = await ask(documentId);
      const { FeedbackService } = await import('../feedback/service.ts');
      const feedback = new FeedbackService({ store, documents });
      const paused = pauseRender();
      const issuing = render.createGrantForRequest(sessionId, request.requestId, GRANT_CONTEXT);
      await paused.started;
      if (ending === 'submit') {
        await feedback.submit(request.requestId, {
          submissionId: `sub_${randomUUID()}`,
          expectedDraftVersion: 0,
          revision: request.revision,
          currentRevision: request.revision,
        });
      } else {
        await feedback.cancel({ requestId: request.requestId }, 'agent');
        if (ending === 'forget') {
          await feedback.forget({ requestId: request.requestId, confirmed: true });
        }
      }
      paused.resume();
      await expect(issuing).rejects.toMatchObject({
        code: ending === 'forget' ? 'E_REQUEST_NOT_FOUND' : 'E_REQUEST_NOT_PENDING',
      });
      expect(render.grantCount).toBe(0);
    },
  );

  it('scriptの実行の許可が外れたら、発行済みのinteractiveの表示は使えない', async () => {
    const documentId = await openInteractive();
    const grant = await render.createGrant(
      sessionId,
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    expect(await body(grant.grant, grant.documentLogicalPath)).not.toBeNull();
    await documents.setHtmlMode({ documentId, mode: 'static' });
    expect(await render.resolve(grant.grant, grant.documentLogicalPath)).toBeNull();
  });

  it('登録されていないfileの読み込みを、表示ごとに記録して知らせる。別のsessionからは見えない', async () => {
    const notified: string[] = [];
    const sessions = createSessionService();
    const owner = sessions.idOf(sessions.exchange(sessions.createBootstrapTicket()) as string);
    const other = sessions.idOf(sessions.exchange(sessions.createBootstrapTicket()) as string);
    const tracking = createRenderService({
      store,
      documents,
      sessions,
      parse: {
        analyze: (format, text) => Promise.resolve(analyzeDocument(text, format)),
        scan: (kind, text) => Promise.resolve(scanReferences(kind, text)),
        render: (input) => Promise.resolve(renderDocument(input)),
        close: () => Promise.resolve(),
      },
      previewOrigin: () => 'http://127.0.0.1:1',
      onMissing: (documentId) => notified.push(documentId),
    });
    const documentId = await openInteractive();
    const { grant } = await tracking.createGrant(
      owner,
      { documentId, mode: 'interactive' },
      GRANT_CONTEXT,
    );
    expect(await tracking.resolve(grant, 'data.json')).toBeNull();
    expect(await tracking.resolve(grant, 'data.json')).toBeNull();
    expect(await tracking.resolve(grant, 'mod.js')).toBeNull();
    expect(tracking.missingOf(owner, grant)).toEqual(['data.json', 'mod.js']);
    expect(tracking.missingOf(other, grant)).toEqual([]);
    // 同じfileは1回だけ知らせる。
    expect(notified).toEqual([documentId, documentId]);
  });
});
