import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireLock, releaseLock, systemProcessProbe } from '../../apps/cli/src/daemon/lock.ts';
import { START_LOCK_NAME } from '../../apps/cli/src/daemon/runtime-files.ts';
import { cliEntry, createTestHome, type JsonEnvelope, type TestHome } from './harness.ts';
import { connectUi, type UiClient } from './ui-client.ts';

interface Request {
  requestId: string;
  documentId: string;
  revision: string;
  title: string;
  status: 'pending' | 'submitted' | 'cancelled';
  submission: null | {
    submissionId: string;
    answers: Record<string, unknown>;
    revision: string;
    confirmedAgainstOlderRevision: boolean;
  };
  cancellation: null | { reason: string };
  acknowledgedAt: string | null;
}

const SECRET = 'ANSWER-SECRET-7f3a';
const questionnaire = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  instructions: '採用案と表示密度を選んでください。',
  fieldOrder: ['layout', 'density', 'comment'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      density: { type: 'string', title: '表示密度', enum: ['comfortable', 'compact'] },
      comment: { type: 'string', title: '修正したい点', maxLength: 4000 },
    },
    required: ['layout', 'density'],
    additionalProperties: false,
  },
};

let t: TestHome;

beforeEach(() => {
  t = createTestHome();
  t.write('q.json', JSON.stringify(questionnaire));
});

afterEach(async () => {
  await t.cleanup();
});

async function ask(...args: string[]): Promise<Request> {
  const result = await t.run(['ask', 'q.json', ...args, '--json']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  return result.json<{ request: Request }>().data.request;
}

// Save the draft answer and submit it, following the same steps as the management UI.
async function answerFromUi(
  ui: UiClient,
  requestId: string,
  answers: Record<string, unknown> = { layout: 'B', density: 'compact', comment: SECRET },
): Promise<Request> {
  const before = (await ui.api<{ draftVersion: number }>(`/feedback/${requestId}`)).json.data;
  const draft = await ui.api<{ draftVersion: number }>(`/feedback/${requestId}/draft`, {
    method: 'PUT',
    body: { expectedDraftVersion: before.draftVersion, answers },
  });
  expect(draft.status).toBe(200);
  const shown = (await ui.api<Request & { currentRevision: string }>(`/feedback/${requestId}`)).json
    .data;
  const submitted = await ui.api<Request>(`/feedback/${requestId}/submit`, {
    method: 'POST',
    body: {
      submissionId: `sub_${crypto.randomUUID()}`,
      expectedDraftVersion: draft.json.data.draftVersion,
      revision: shown.revision,
      currentRevision: shown.currentRevision,
    },
  });
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
  return submitted.json.data;
}

// Start the CLI in a child process (to send SIGINT).
function spawnCli(args: string[]): {
  done: Promise<{ exitCode: number | null; stdout: string }>;
  interrupt: () => void;
} {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: t.work,
    env: { ...process.env, VDE_OPEN_HOME: t.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  return {
    done: new Promise((resolve) => {
      child.on('close', (exitCode) => resolve({ exitCode, stdout }));
    }),
    interrupt: () => child.kill('SIGINT'),
  };
}

const status = async (requestId: string) =>
  (await t.run(['feedback', 'get', requestId, '--json'])).json<Request>().data.status;

describe('FB-005 / FB-006 questions from the CLI', () => {
  it('ask creates a question document when there is none, and handles duplicates for the same document and operation ID replays and conflicts', async () => {
    const request = await ask();
    const listed = (await t.run(['list', '--json'])).json<{
      documents: Array<{ documentId: string; sourceKind: string; pendingRequestIds: string[] }>;
    }>().data.documents;
    expect(listed).toEqual([
      expect.objectContaining({
        documentId: request.documentId,
        sourceKind: 'generated',
        pendingRequestIds: [request.requestId],
      }),
    ]);
    const duplicate = await t.run(['ask', 'q.json', '--document', request.documentId, '--json']);
    expect(duplicate.exitCode).toBe(4);
    expect(duplicate.json().error.code).toBe('E_PENDING_REQUEST_EXISTS');

    t.write('a.md', '# 画面\n');
    const operationId = crypto.randomUUID();
    const first = await ask('--view', 'a.md', '--operation-id', operationId);
    const again = await t.run([
      'ask',
      'q.json',
      '--view',
      'a.md',
      '--operation-id',
      operationId,
      '--json',
    ]);
    expect(again.json<{ request: Request; replayed: boolean }>().data).toMatchObject({
      replayed: true,
      request: { requestId: first.requestId },
    });
    t.write('q2.json', JSON.stringify({ ...questionnaire, title: '別の質問' }));
    const conflict = await t.run([
      'ask',
      'q2.json',
      '--view',
      'a.md',
      '--operation-id',
      operationId,
      '--json',
    ]);
    expect(conflict.exitCode).toBe(4);
    expect(conflict.json().error.code).toBe('E_OPERATION_CONFLICT');
  });

  it('FB-002 rejects an invalid questionnaire with exit code 2 and registers nothing', async () => {
    const cases: Array<[string, string]> = [
      [
        'dup.json',
        JSON.stringify(questionnaire).replace('"title":"採用案"', '"title":"採用案","title":"x"'),
      ],
      [
        'ref.json',
        JSON.stringify({
          ...questionnaire,
          answerSchema: { ...questionnaire.answerSchema, $ref: 'https://example.com/s.json' },
        }),
      ],
      [
        'proto.json',
        JSON.stringify(questionnaire).replace(
          '"layout":{',
          '"__proto__":{"type":"boolean","title":"x"},"layout":{',
        ),
      ],
      ['broken.json', '{"schemaVersion":1,'],
    ];
    for (const [name, content] of cases) {
      t.write(name, content);
      const result = await t.run(['ask', name, '--json']);
      expect(result.exitCode, name).toBe(2);
      expect(result.json().error.code, name).toBe('E_QUESTIONNAIRE_INVALID');
    }
    expect(
      (await t.run(['feedback', 'list', '--json'])).json<{ requests: unknown[] }>().data.requests,
    ).toEqual([]);
    expect(
      (await t.run(['list', '--json'])).json<{ documents: unknown[] }>().data.documents,
    ).toEqual([]);
  });
});

describe('FB-004 / FB-019 fetching answers and acknowledging', () => {
  it('draft answers are not returned to the Agent; after submit the confirmed answers are returned, and reading alone does not acknowledge', async () => {
    const request = await ask();
    const ui = await connectUi(t);
    await ui.api(`/feedback/${request.requestId}/draft`, {
      method: 'PUT',
      body: { expectedDraftVersion: 0, answers: { layout: 'A', comment: SECRET } },
    });
    for (const args of [
      ['get', request.requestId],
      ['list'],
      ['wait', request.requestId, '--timeout', '1'],
    ]) {
      const result = await t.run(['feedback', ...args, '--json']);
      expect(result.stdout).not.toContain(SECRET);
    }
    const submitted = await answerFromUi(ui, request.requestId);
    const got = (await t.run(['feedback', 'get', request.requestId, '--json'])).json<Request>()
      .data;
    expect(got).toMatchObject({
      status: 'submitted',
      acknowledgedAt: null,
      submission: { answers: { layout: 'B', density: 'compact', comment: SECRET } },
    });
    const waited = (await t.run(['feedback', 'wait', request.requestId, '--json'])).json<Request>();
    expect(waited.data.submission).toEqual(got.submission);
    expect(
      (await t.run(['feedback', 'get', request.requestId, '--json'])).json<Request>().data
        .acknowledgedAt,
    ).toBeNull();
    const submissionId = submitted.submission?.submissionId as string;
    const acked = (
      await t.run(['feedback', 'ack', request.requestId, '--submission-id', submissionId, '--json'])
    ).json<Request>().data;
    const again = (
      await t.run(['feedback', 'ack', request.requestId, '--submission-id', submissionId, '--json'])
    ).json<Request>().data;
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(again.acknowledgedAt).toBe(acked.acknowledgedAt);
    // The management UI can also tell it is acknowledged.
    expect((await ui.api<Request>(`/feedback/${request.requestId}`)).json.data.acknowledgedAt).toBe(
      acked.acknowledgedAt,
    );
  });

  it('the management API draft answer rejects duplicate keys and `__proto__`', async () => {
    const request = await ask();
    const ui = await connectUi(t);
    const { rawRequest } = await import('./ui-client.ts');
    for (const body of [
      '{"expectedDraftVersion":0,"answers":{"layout":"A","layout":"B"}}',
      '{"expectedDraftVersion":0,"answers":{"__proto__":{"layout":"A"}}}',
    ]) {
      const response = await rawRequest(
        ui.origin,
        `/_/api/v1/feedback/${request.requestId}/draft`,
        {
          method: 'PUT',
          headers: {
            Origin: ui.origin,
            'Content-Type': 'application/json',
          },
          body,
        },
      );
      expect(response.status).toBe(400);
    }
    expect(
      (await ui.api<{ draftVersion: number }>(`/feedback/${request.requestId}`)).json.data
        .draftVersion,
    ).toBe(0);
  });
});

describe('FB-017 / FB-018 how waiting ends, and cancel', () => {
  it('wait timeout exits 6, interrupt exits 130; in both the question stays pending', async () => {
    const request = await ask();
    const timedOut = await t.run([
      'feedback',
      'wait',
      request.requestId,
      '--timeout',
      '1',
      '--json',
    ]);
    expect(timedOut.exitCode).toBe(6);
    expect(timedOut.json().error.code).toBe('E_TIMEOUT');
    expect(await status(request.requestId)).toBe('pending');

    const waiting = spawnCli(['feedback', 'wait', request.requestId, '--timeout', '60', '--json']);
    await new Promise((done) => setTimeout(done, 1500));
    waiting.interrupt();
    const interrupted = await waiting.done;
    expect(interrupted.exitCode).toBe(130);
    expect((JSON.parse(interrupted.stdout) as JsonEnvelope<never>).error.code).toBe(
      'E_INTERRUPTED',
    );
    expect(await status(request.requestId)).toBe('pending');
  });

  it('a question whose document was closed and an explicitly cancelled question are fetched as cancelled (exit code 0)', async () => {
    t.write('a.md', '# A\n');
    const closedOne = await ask('--view', 'a.md');
    const waiting = t.run(['feedback', 'wait', closedOne.requestId, '--timeout', '30', '--json']);
    await new Promise((done) => setTimeout(done, 1000));
    expect((await t.run(['close', 'a.md', '--json'])).exitCode).toBe(0);
    const waited = await waiting;
    expect(waited.exitCode).toBe(0);
    expect(waited.json<Request>().data).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'document_closed' },
    });

    const cancelledOne = await ask();
    const cancelled = await t.run(['feedback', 'cancel', cancelledOne.requestId, '--json']);
    expect(cancelled.exitCode).toBe(0);
    const got = await t.run(['feedback', 'get', cancelledOne.requestId, '--json']);
    expect(got.exitCode).toBe(0);
    expect(got.json<Request>().data.cancellation?.reason).toBe('agent_cancelled');
  });
});

describe('FB-020 / FB-021 deleting finished questions', () => {
  it('a pending question cannot be deleted; only finished ones are deleted with --yes, and the source file, document, and other questions remain', async () => {
    t.write('a.md', '# A\n');
    const done = await ask('--view', 'a.md');
    const other = await ask();
    const ui = await connectUi(t);
    const pendingForget = await t.run(['feedback', 'forget', other.requestId, '--yes', '--json']);
    expect(pendingForget.exitCode).toBe(4);
    expect(pendingForget.json().error.code).toBe('E_REQUEST_PENDING');
    await answerFromUi(ui, done.requestId);
    const draftAfter = await ui.api(`/feedback/${done.requestId}/draft`, {
      method: 'PUT',
      body: { expectedDraftVersion: 1, answers: {} },
    });
    expect(draftAfter.json.error.code).toBe('E_REQUEST_NOT_PENDING');
    const unconfirmed = await t.run(['feedback', 'forget', done.requestId, '--json']);
    expect(unconfirmed.exitCode).toBe(2);
    expect((await t.run(['feedback', 'forget', done.requestId, '--yes', '--json'])).exitCode).toBe(
      0,
    );
    expect((await t.run(['feedback', 'get', done.requestId, '--json'])).exitCode).toBe(3);
    expect(await status(other.requestId)).toBe('pending');
    expect(existsSync(join(t.work, 'a.md'))).toBe(true);
    const listed = (await t.run(['list', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents;
    expect(listed.map((document) => document.documentId)).toContain(done.documentId);
  });
});

describe('SYS-003 / SYS-013 / DOC-016 restart and wait, close --all', () => {
  it('when the daemon stops and restarts, wait reconnects within the original deadline and receives the answer to the same question', async () => {
    const request = await ask();
    const waiting = spawnCli(['feedback', 'wait', request.requestId, '--timeout', '30', '--json']);
    await new Promise((done) => setTimeout(done, 1000));
    expect((await t.run(['daemon', 'stop', '--json'])).exitCode).toBe(0);
    // Wait for the wait command to reconnect (restarting the daemon).
    await new Promise((done) => setTimeout(done, 1500));
    const ui = await connectUi(t);
    await answerFromUi(ui, request.requestId);
    const result = await waiting.done;
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as JsonEnvelope<Request>).data.status).toBe('submitted');
  });

  it('times out without extending the remaining time even when the daemon stops', async () => {
    const request = await ask();
    const startedAt = Date.now();
    const waiting = spawnCli(['feedback', 'wait', request.requestId, '--timeout', '3', '--json']);
    await new Promise((done) => setTimeout(done, 1000));
    await t.run(['daemon', 'stop', '--json']);
    const result = await waiting.done;
    const elapsed = Date.now() - startedAt;
    expect(result.exitCode).toBe(6);
    expect(elapsed).toBeLessThan(3000 + 2500);
  });

  it('the CLI process exits right after the deadline even if it arrives while waiting for the daemon to start', async () => {
    const request = await ask();
    expect((await t.run(['daemon', 'stop', '--json'])).exitCode).toBe(0);
    // Hold the start lock as if another process were in the middle of starting (this process is alive).
    const ownerId = `start_${crypto.randomUUID()}`;
    const held = await acquireLock(
      t.home,
      START_LOCK_NAME,
      { pid: process.pid, ownerId },
      systemProcessProbe,
    );
    expect(held.acquired).toBe(true);
    try {
      const startedAt = Date.now();
      const waiting = spawnCli(['feedback', 'wait', request.requestId, '--timeout', '1', '--json']);
      const result = await waiting.done;
      // Waiting for startup (up to 10 seconds) or connection timers must not keep the process alive.
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(result.exitCode).toBe(6);
      expect((JSON.parse(result.stdout) as JsonEnvelope<unknown>).error.code).toBe('E_TIMEOUT');
    } finally {
      await releaseLock(t.home, START_LOCK_NAME, ownerId);
    }
    expect(await status(request.requestId)).toBe('pending');
  });

  it('questions and answers survive a restart; close --all keeps the answer history and source files, and cancels pending ones', async () => {
    t.write('a.md', '# A\n');
    t.write('b.md', '# B\n');
    const answered = await ask('--view', 'a.md');
    const waiting = await ask('--view', 'b.md');
    const ui = await connectUi(t);
    await answerFromUi(ui, answered.requestId);
    expect((await t.run(['open', '-w', '.', '--json'])).exitCode).toBe(0);
    await t.run(['daemon', 'restart', '--json']);
    // The new daemon remains directly accessible without a browser session.
    const restarted = await connectUi(t);
    expect((await restarted.api('/feedback')).status).toBe(200);
    const restored = (
      await t.run(['feedback', 'get', answered.requestId, '--json'])
    ).json<Request>().data;
    expect(restored.submission?.answers).toEqual({
      layout: 'B',
      density: 'compact',
      comment: SECRET,
    });
    expect(await status(waiting.requestId)).toBe('pending');

    expect((await t.run(['close', '--all', '--json'])).exitCode).toBe(0);
    expect(
      (await t.run(['list', '--json'])).json<{ documents: unknown[] }>().data.documents,
    ).toEqual([]);
    expect(
      (await t.run(['watch', 'list', '--json'])).json<{ watchRules: unknown[] }>().data.watchRules,
    ).toEqual([]);
    expect(await status(answered.requestId)).toBe('submitted');
    expect(await status(waiting.requestId)).toBe('cancelled');
    expect(existsSync(join(t.work, 'a.md'))).toBe(true);
  });
});

describe('SYS-014 / SEC-018 concurrent operations and the log', () => {
  it('state stays consistent and submit is confirmed only once even when draft save, submit, reorder, and close run concurrently', async () => {
    t.write('a.md', '# A\n');
    t.write('b.md', '# B\n');
    const request = await ask('--view', 'a.md');
    await t.run(['open', 'b.md', '--json']);
    const ui = await connectUi(t);
    const draft = await ui.api<{ draftVersion: number }>(`/feedback/${request.requestId}/draft`, {
      method: 'PUT',
      body: { expectedDraftVersion: 0, answers: { layout: 'A', density: 'compact' } },
    });
    const listed = (await ui.api<{ documents: Array<{ documentId: string }> }>('/documents')).json
      .data;
    const catalogVersion = (await ui.api<{ catalogVersion: number }>('/status')).json.data
      .catalogVersion;
    const submit = (submissionId: string) =>
      ui.api(`/feedback/${request.requestId}/submit`, {
        method: 'POST',
        body: {
          submissionId,
          expectedDraftVersion: draft.json.data.draftVersion,
          revision: request.revision,
          currentRevision: request.revision,
        },
      });
    const results = await Promise.all([
      submit(`sub_${crypto.randomUUID()}`),
      submit(`sub_${crypto.randomUUID()}`),
      ui.api(`/feedback/${request.requestId}/draft`, {
        method: 'PUT',
        body: {
          expectedDraftVersion: draft.json.data.draftVersion,
          answers: { layout: 'B', density: 'compact' },
        },
      }),
      ui.api('/documents/order', {
        method: 'PUT',
        body: {
          order: listed.documents.map((document) => document.documentId).toReversed(),
          expectedCatalogVersion: catalogVersion,
        },
      }),
      t.run(['close', 'b.md', '--json']),
    ]);
    const submitted = results
      .slice(0, 2)
      .filter((result) => 'status' in result && result.status === 200);
    const final = (await t.run(['feedback', 'get', request.requestId, '--json'])).json<Request>()
      .data;
    // If submit was confirmed, only once. If the draft update came first, submit is rejected as a conflict.
    expect(submitted.length).toBeLessThanOrEqual(1);
    expect(['pending', 'submitted']).toContain(final.status);
    expect(final.status === 'submitted').toBe(submitted.length === 1);
    // The state can be reloaded consistently.
    await t.run(['daemon', 'restart', '--json']);
    expect(
      (await t.run(['feedback', 'get', request.requestId, '--json'])).json<Request>().data.status,
    ).toBe(final.status);
  });

  it('when closing the question document and submit overlap, exactly one of confirmed or cancelled results', async () => {
    t.write('a.md', '# A\n');
    let connected: UiClient | null = null;
    const outcomes: Array<{ submit: number; status: string; reason: string | null }> = [];
    // Try several times, alternating which of submit and close is issued first.
    for (const closeFirst of [false, true, false, true]) {
      const request = await ask('--view', 'a.md');
      const ui = (connected ??= await connectUi(t));
      const draft = await ui.api<{ draftVersion: number }>(`/feedback/${request.requestId}/draft`, {
        method: 'PUT',
        body: { expectedDraftVersion: 0, answers: { layout: 'A', density: 'compact' } },
      });
      const submit = () =>
        ui.api(`/feedback/${request.requestId}/submit`, {
          method: 'POST',
          body: {
            submissionId: `sub_${crypto.randomUUID()}`,
            expectedDraftVersion: draft.json.data.draftVersion,
            revision: request.revision,
            currentRevision: request.revision,
          },
        });
      const close = () => ui.api(`/documents/${request.documentId}`, { method: 'DELETE' });
      const [submitted, closed] = closeFirst
        ? await Promise.all([close(), submit()]).then(([c, s]) => [s, c] as const)
        : await Promise.all([submit(), close()]);
      expect(closed.status).toBe(200);
      const final = (await t.run(['feedback', 'get', request.requestId, '--json'])).json<Request>()
        .data;
      outcomes.push({
        submit: submitted.status,
        status: final.status,
        reason: final.cancellation?.reason ?? null,
      });
    }
    for (const outcome of outcomes) {
      expect([
        { submit: 200, status: 'submitted', reason: null },
        { submit: 409, status: 'cancelled', reason: 'document_closed' },
      ]).toContainEqual(outcome);
    }
    // The state can be reloaded consistently.
    expect((await t.run(['daemon', 'restart', '--json'])).exitCode).toBe(0);
    const listed = (await t.run(['feedback', 'list', '--json'])).json<{ requests: Request[] }>()
      .data.requests;
    expect(listed.map((request) => request.status)).toEqual(
      outcomes.map((outcome) => outcome.status),
    );
  });

  it('the log contains no secrets or content even after operations involving answers and draft answers', async () => {
    const request = await ask();
    const ui = await connectUi(t);
    await answerFromUi(ui, request.requestId);
    await t.run(['feedback', 'get', request.requestId, '--json']);
    await t.run(['daemon', 'stop', '--json']);
    const log = readFileSync(join(t.home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('採用案');
    expect(log).not.toContain('ログイン画面の確認');
  });
});
