import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
