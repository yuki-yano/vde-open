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
  title: 'Login screen review',
  fieldOrder: ['layout'],
  answerSchema: {
    type: 'object',
    properties: { layout: { type: 'string', title: 'Chosen option', enum: ['A', 'B'] } },
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
  // Submit parameters (only the submission ID is chosen by the caller).
  params: (submissionId: string) => Record<string, unknown>;
}

// Create a question, save a draft answer, and start the management HTTP server.
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
    pdf: {
      exportMarkdown: () => Promise.reject(new Error('Not used in this test.')),
      close: () => Promise.resolve(),
    },
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

// Submit in the same form as the management UI. Returns the request so the connection can be cut before the response.
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

describe('FB-013 disconnect during submit and resend', () => {
  it('even if the connection drops before commit, a resend with the same submission ID yields the same result and submits only once', async () => {
    // Hold the first rename (state commit) after arming until signaled.
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
    // The management UI's connection dropped before commit. Not yet submitted.
    first.request.destroy();
    await expect(first.response).rejects.toThrow();
    expect(started.feedback.get({ requestId: started.requestId }).data.status).toBe('pending');

    // The management UI resends with the same submission ID. The first submit's commit has not finished yet.
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

  it('does not return success for a submit whose save failed. A resend with the same submission ID submits', async () => {
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

describe('11.7 saving a draft answer from the HTML, and grant expiry while waiting', () => {
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
    // Number of state updates (transactions) enqueued, and a function that waits until that count is reached.
    queued: () => number;
    untilQueued: (count: number) => Promise<void>;
  }

  // Ask a question on an interactive HTML and issue a render grant with the SDK injected. The state commit (rename) can be held.
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
    // Count transaction registrations. Confirm queueing by the fact of registration, not by timing.
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
      pdf: {
        exportMarkdown: () => Promise.reject(new Error('Not used in this test.')),
        close: () => Promise.resolve(),
      },
      feedback,
      previewOrigin: 'http://127.0.0.1:1',
      webRoot: null,
      devOrigin: null,
      isStopping: () => false,
      heartbeatMs: 60_000,
    });
    writeFileSync(join(base, 'app.html'), '<p>Body</p>');
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

  // Call the management API in the same form as the management UI.
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
      'the render grant is released',
      (bridged: Bridged) => bridged.render.release(bridged.sessionId, [bridged.grant]),
    ],
    ['the session expires', (bridged: Bridged) => bridged.sessions.revoke(bridged.token)],
  ])(
    'does not save the draft answer from the HTML if %s while waiting its turn to save',
    async (_name, expire) => {
      const bridged = await startBridged();
      const reached = bridged.gate.arm();
      // Hold the save queued first (the management UI's draft answer) mid-commit.
      const first = call(bridged, 'PUT', `/feedback/${bridged.requestId}/draft`, {
        expectedDraftVersion: 0,
        answers: { layout: 'A' },
      });
      await reached;
      const before = bridged.queued();
      // The save from the HTML passes the entry check and joins the queue (confirm it is queued before expiring).
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
    },
  );

  it('does not save the draft answer from the HTML queued later once the script permission revocation queued earlier is committed', async () => {
    const bridged = await startBridged();
    const reached = bridged.gate.arm();
    const first = call(bridged, 'PUT', `/feedback/${bridged.requestId}/draft`, {
      expectedDraftVersion: 0,
      answers: { layout: 'A' },
    });
    await reached;
    const before = bridged.queued();
    // The switch to the static view is queued first, and the save from the HTML after it (permission still exists at the entry check).
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
