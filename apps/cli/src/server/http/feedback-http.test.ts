import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FeedbackForUi, Questionnaire } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../../documents/cursor.ts';
import { DocumentService, type DocumentEvent } from '../../documents/service.ts';
import { FeedbackService } from '../../feedback/service.ts';
import { StateStore } from '../../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../../persistence/store-fs.ts';
import { createRenderService } from '../../render/render-service.ts';
import { createSearchService } from '../../search/search-service.ts';
import { createParseService } from '../../workers/parse-service.ts';
import { createEventHub } from '../event-hub.ts';
import { createSessionService } from '../session-service.ts';
import { startManagementServer, type ManagementServer } from './management.ts';

const questionnaire: Questionnaire = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  fieldOrder: ['layout'],
  answerSchema: {
    type: 'object',
    properties: { layout: { type: 'string', title: '採用案', enum: ['A', 'B'] } },
    required: ['layout'],
    additionalProperties: false,
  },
};

let base: string;
let server: ManagementServer | null;
let store: StateStore | null;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-feedback-http-')));
  server = null;
  store = null;
});

afterEach(async () => {
  await server?.close();
  await store?.close();
  rmSync(base, { recursive: true, force: true });
});

interface Started {
  origin: string;
  token: string;
  feedback: FeedbackService;
  events: DocumentEvent[];
  requestId: string;
  // 送信の条件（送信IDだけ、呼び出し側が決める）。
  params: (submissionId: string) => Record<string, unknown>;
}

// 質問を作って回答案を保存し、管理HTTPを起動する。
async function start(fs: StoreFs): Promise<Started> {
  const opened = await StateStore.open({ root: join(base, 'home'), fs });
  store = opened;
  const cursors = createCursorCodec(randomBytes(32));
  const events: DocumentEvent[] = [];
  const emit = (event: DocumentEvent) => {
    events.push(event);
    if (event.type === 'feedback-changed' && event.requestId) feedback.wake(event.requestId);
  };
  const documents = new DocumentService({ store: opened, cursors, emit });
  const feedback = new FeedbackService({ store: opened, documents, emit });
  const sessions = createSessionService();
  server = await startManagementServer({
    daemonId: 'daemon_test',
    version: '0.0.0',
    documents,
    sessions,
    events: createEventHub('daemon_test', () => opened.payload.catalogVersion),
    render: createRenderService({
      store: opened,
      documents,
      sessions,
      parse: createParseService(),
      previewOrigin: () => 'http://127.0.0.1:1',
    }),
    search: createSearchService({ store: opened, cursors }),
    feedback,
    previewOrigin: 'http://127.0.0.1:1',
    webRoot: null,
    devOrigin: null,
    isStopping: () => false,
    heartbeatMs: 60_000,
  });
  const { request } = (
    await feedback.create({ cwd: base, questionnaire: JSON.stringify(questionnaire) })
  ).data;
  const draft = await feedback.updateDraft(request.requestId, {
    expectedDraftVersion: 0,
    answers: { layout: 'B' },
  });
  return {
    origin: server.origin,
    token: sessions.exchange(sessions.createBootstrapTicket()) as string,
    feedback,
    events,
    requestId: request.requestId,
    params: (submissionId) => ({
      submissionId,
      expectedDraftVersion: draft.data.draftVersion,
      revision: request.revision,
      currentRevision: request.revision,
    }),
  };
}

interface Sent {
  request: ClientRequest;
  response: Promise<{ status: number; body: { ok: boolean; data?: FeedbackForUi } }>;
}

// 管理UIと同じ形で送信する。requestを返すので、応答の前に接続を切れる。
function submit(started: Started, submissionId: string): Sent {
  const url = new URL(started.origin);
  const body = JSON.stringify(started.params(submissionId));
  let request: ClientRequest | null = null;
  const response = new Promise<Sent['response'] extends Promise<infer R> ? R : never>(
    (resolve, reject) => {
      request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `/_/api/v1/feedback/${started.requestId}/submit`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${started.token}`,
            Origin: started.origin,
            'Content-Type': 'application/json',
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            resolve({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                ok: boolean;
                data?: FeedbackForUi;
              },
            });
          });
        },
      );
      request.on('error', reject);
      request.end(body);
    },
  );
  return { request: request as unknown as ClientRequest, response };
}

const submittedEvents = (events: DocumentEvent[]) =>
  events.filter((event) => event.type === 'feedback-changed' && event.status === 'submitted');

describe('FB-013 送信の通信切断と再送', () => {
  it('commitの前に通信が切れても、同じ送信IDの再送は同じ結果になり、1回だけ確定する', async () => {
    // 有効にした後の最初のrename（stateのcommit）を、合図があるまで止める。
    const gate = { armed: false, reached: () => undefined, release: () => undefined } as {
      armed: boolean;
      reached: () => void;
      release: () => void;
    };
    const reached = new Promise<void>((resolve) => {
      gate.reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const started = await start({
      ...nodeStoreFs,
      rename: async (from, to) => {
        if (gate.armed) {
          gate.armed = false;
          gate.reached();
          await released;
        }
        return nodeStoreFs.rename(from, to);
      },
    });
    const submissionId = `sub_${randomUUID()}`;
    gate.armed = true;
    const first = submit(started, submissionId);
    first.response.catch(() => undefined);
    await reached;
    // commitの前に、管理UI側の接続が切れた。まだ確定していない。
    first.request.destroy();
    await expect(first.response).rejects.toThrow();
    expect(started.feedback.get({ requestId: started.requestId }).data.status).toBe('pending');

    // 管理UIは、同じ送信IDで再送する。最初の送信のcommitは、まだ終わっていない。
    const again = submit(started, submissionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.release();
    const replayed = await again.response;
    expect(replayed.status).toBe(200);
    expect(replayed.body.data?.submission).toMatchObject({
      submissionId,
      answers: { layout: 'B' },
    });
    expect(submittedEvents(started.events)).toHaveLength(1);
    expect(started.feedback.get({ requestId: started.requestId }).data.submission).toEqual(
      replayed.body.data?.submission,
    );
  });

  it('保存に失敗した送信には成功を返さない。同じ送信IDの再送で確定する', async () => {
    let failWrites = false;
    const started = await start({
      ...nodeStoreFs,
      writeFileDurable: async (path, data, mode) => {
        if (failWrites && path.includes('.tmp-state-')) {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        }
        return nodeStoreFs.writeFileDurable(path, data, mode);
      },
    });
    const submissionId = `sub_${randomUUID()}`;
    failWrites = true;
    const failed = await submit(started, submissionId).response;
    expect(failed.status).not.toBe(200);
    expect(failed.body.ok).toBe(false);
    expect(started.feedback.get({ requestId: started.requestId }).data.status).toBe('pending');
    expect(submittedEvents(started.events)).toEqual([]);

    failWrites = false;
    const retried = await submit(started, submissionId).response;
    expect(retried.status).toBe(200);
    expect(retried.body.data?.status).toBe('submitted');
    expect(submittedEvents(started.events)).toHaveLength(1);
  });
});

describe('11.7 HTMLからの回答案の保存と、待っている間の権限の失効', () => {
  interface Bridged {
    origin: string;
    token: string;
    sessions: ReturnType<typeof createSessionService>;
    documents: DocumentService;
    feedback: FeedbackService;
    render: ReturnType<typeof createRenderService>;
    requestId: string;
    documentId: string;
    grant: string;
    sessionId: string;
    gate: { arm: () => Promise<void>; release: () => void };
    // stateの更新（transaction）を待ち行列へ登録した数と、その数に達するまで待つ関数。
    queued: () => number;
    untilQueued: (count: number) => Promise<void>;
  }

  // interactiveのHTMLへ質問し、SDKを入れた表示の権限を発行する。stateのcommit（rename）を止められる。
  async function startBridged(): Promise<Bridged> {
    let armed = false;
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const opened = await StateStore.open({
      root: join(base, 'home'),
      fs: {
        ...nodeStoreFs,
        rename: async (from, to) => {
          if (armed) {
            armed = false;
            reached();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return nodeStoreFs.rename(from, to);
        },
      },
    });
    store = opened;
    // transactionの登録を数える。待ち行列に並んだことを、時間ではなく、登録の事実で確かめる。
    let queued = 0;
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    const transaction = opened.transaction.bind(opened);
    opened.transaction = ((mutate) => {
      const result = transaction(mutate);
      queued += 1;
      for (const waiter of waiters.filter((entry) => queued >= entry.count)) waiter.resolve();
      return result;
    }) as typeof opened.transaction;
    const cursors = createCursorCodec(randomBytes(32));
    const documents = new DocumentService({ store: opened, cursors });
    const feedback = new FeedbackService({ store: opened, documents });
    const sessions = createSessionService();
    const render = createRenderService({
      store: opened,
      documents,
      sessions,
      parse: createParseService(),
      previewOrigin: () => 'http://127.0.0.1:1',
    });
    server = await startManagementServer({
      daemonId: 'daemon_test',
      version: '0.0.0',
      documents,
      sessions,
      events: createEventHub('daemon_test', () => opened.payload.catalogVersion),
      render,
      search: createSearchService({ store: opened, cursors }),
      feedback,
      previewOrigin: 'http://127.0.0.1:1',
      webRoot: null,
      devOrigin: null,
      isStopping: () => false,
      heartbeatMs: 60_000,
    });
    writeFileSync(join(base, 'app.html'), '<p>本文</p>');
    const document = (
      await documents.open({ cwd: base, paths: ['app.html'], htmlMode: 'interactive' })
    ).data.documents[0] as { documentId: string };
    const { request } = (
      await feedback.create({
        cwd: base,
        questionnaire: JSON.stringify(questionnaire),
        documentId: document.documentId,
      })
    ).data;
    const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
    const sessionId = sessions.idOf(token);
    const issued = await render.createGrantForRequest(sessionId, request.requestId, {
      origin: server.origin,
    });
    return {
      origin: server.origin,
      token,
      sessions,
      documents,
      feedback,
      render,
      requestId: request.requestId,
      documentId: document.documentId,
      grant: issued.grant,
      sessionId,
      gate: {
        arm: () =>
          new Promise<void>((resolve) => {
            armed = true;
            reached = resolve;
          }),
        release: () => release(),
      },
      queued: () => queued,
      untilQueued: (count) =>
        new Promise<void>((resolve) => {
          if (queued >= count) resolve();
          else waiters.push({ count, resolve });
        }),
    };
  }

  // 管理UIと同じ形で、管理APIを呼ぶ。
  function call(
    bridged: Bridged,
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; code: string | null }> {
    const url = new URL(bridged.origin);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `/_/api/v1${path}`,
          method,
          headers: {
            Authorization: `Bearer ${bridged.token}`,
            Origin: bridged.origin,
            'Content-Type': 'application/json',
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              error?: { code: string };
            };
            resolve({ status: incoming.statusCode ?? 0, code: parsed.error?.code ?? null });
          });
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
  }

  it.each([
    [
      '表示の権限を返却した',
      (bridged: Bridged) => bridged.render.release(bridged.sessionId, [bridged.grant]),
    ],
    ['sessionが失効した', (bridged: Bridged) => bridged.sessions.revoke(bridged.token)],
  ])('保存の順番を待つ間に%s場合、HTMLからの回答案は保存しない', async (_name, expire) => {
    const bridged = await startBridged();
    const reached = bridged.gate.arm();
    // 先に並んだ保存（管理UIの回答案）を、commitの途中で止める。
    const first = call(bridged, 'PUT', `/feedback/${bridged.requestId}/draft`, {
      expectedDraftVersion: 0,
      answers: { layout: 'A' },
    });
    await reached;
    const before = bridged.queued();
    // HTMLからの保存は、入口の確認を通って、待ち行列に並ぶ（並んだことを確かめてから失効させる）。
    const fromHtml = call(bridged, 'PUT', '/render-grants/bridge/draft', {
      grant: bridged.grant,
      expectedDraftVersion: 1,
      answers: { layout: 'B' },
    });
    await bridged.untilQueued(before + 1);
    expire(bridged);
    bridged.gate.release();
    expect(await first).toEqual({ status: 200, code: null });
    expect(await fromHtml).toEqual({ status: 403, code: 'E_RENDER_GRANT_INVALID' });
    expect(bridged.feedback.getForUi(bridged.requestId).data).toMatchObject({
      draftVersion: 1,
      draftAnswers: { layout: 'A' },
    });
  });

  it('先に並んだscriptの許可の取消がcommitされたら、後に並んだHTMLからの回答案は保存しない', async () => {
    const bridged = await startBridged();
    const reached = bridged.gate.arm();
    const first = call(bridged, 'PUT', `/feedback/${bridged.requestId}/draft`, {
      expectedDraftVersion: 0,
      answers: { layout: 'A' },
    });
    await reached;
    const before = bridged.queued();
    // 静的表示への切り替えが先に並び、HTMLからの保存が後に並ぶ（入口では、まだ許可がある）。
    const revoking = bridged.documents.setHtmlMode({
      documentId: bridged.documentId,
      mode: 'static',
    });
    const fromHtml = call(bridged, 'PUT', '/render-grants/bridge/draft', {
      grant: bridged.grant,
      expectedDraftVersion: 1,
      answers: { layout: 'B' },
    });
    await bridged.untilQueued(before + 2);
    bridged.gate.release();
    await first;
    await revoking;
    expect(await fromHtml).toEqual({ status: 403, code: 'E_RENDER_GRANT_INVALID' });
    expect(bridged.feedback.getForUi(bridged.requestId).data.draftAnswers).toEqual({
      layout: 'A',
    });
  });
});
