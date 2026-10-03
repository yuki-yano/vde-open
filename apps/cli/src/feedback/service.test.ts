import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Questionnaire } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../documents/cursor.ts';
import { DocumentService, type DocumentEvent } from '../documents/service.ts';
import { findIntegrityProblem } from '../persistence/state-schema.ts';
import { StateStore } from '../persistence/state-store.ts';
import { nodeStoreFs, type StoreFs } from '../persistence/store-fs.ts';
import { FeedbackService } from './service.ts';

const questionnaire: Questionnaire = {
  schemaVersion: 1,
  title: 'Login screen review',
  instructions: 'Choose the layout and display density.',
  fieldOrder: ['layout', 'density', 'comment'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: 'Layout', enum: ['A', 'B'] },
      density: { type: 'string', title: 'Display density', enum: ['comfortable', 'compact'] },
      comment: { type: 'string', title: 'Requested changes', maxLength: 4000 },
    },
    required: ['layout', 'density'],
    additionalProperties: false,
  },
};
const text = JSON.stringify(questionnaire);

let base: string;
let store: StateStore;
let documents: DocumentService;
let feedback: FeedbackService;
let events: DocumentEvent[];

async function setup(fs: StoreFs = nodeStoreFs, blobStoreBytes?: number): Promise<void> {
  store = await StateStore.open({
    root: join(base, 'home'),
    fs,
    ...(blobStoreBytes === undefined ? {} : { blobStoreBytes }),
  });
  events = [];
  const emit = (event: DocumentEvent) => {
    events.push(event);
    if (event.type === 'feedback-changed' && event.requestId) feedback.wake(event.requestId);
  };
  documents = new DocumentService({ store, cursors: createCursorCodec(randomBytes(32)), emit });
  feedback = new FeedbackService({ store, documents, emit });
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vde-open-feedback-')));
  await setup();
});

afterEach(() => {
  feedback.close();
  rmSync(base, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(base, name), content);
}

async function openDocument(
  name: string,
  content: string,
): Promise<{ documentId: string; revision: string }> {
  write(name, content);
  const opened = await documents.open({ cwd: base, paths: [name] });
  const [document] = opened.data.documents;
  return { documentId: document?.documentId as string, revision: document?.revision as string };
}

async function ask(params: Record<string, unknown> = {}) {
  return (await feedback.create({ cwd: base, questionnaire: text, ...params })).data;
}

const complete = { layout: 'B', density: 'compact', comment: 'Shorten the description' };

async function answer(requestId: string, answers: Record<string, unknown> = complete) {
  const draft = await feedback.updateDraft(requestId, { expectedDraftVersion: 0, answers });
  const request = feedback.getForUi(requestId).data;
  return {
    draftVersion: draft.data.draftVersion,
    submit: (overrides: Record<string, unknown> = {}) =>
      feedback.submit(requestId, {
        submissionId: `sub_${randomUUID()}`,
        expectedDraftVersion: draft.data.draftVersion,
        revision: request.revision,
        currentRevision: request.currentRevision,
        ...overrides,
      }),
  };
}

describe('FB-005 / FB-006 creating questions', () => {
  it('without a document, creates a document from the question title and instructions and pins to its revision', async () => {
    const { request } = await ask();
    const listed = documents.list({}).data.documents;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      documentId: request.documentId,
      sourceKind: 'generated',
      displayPath: null,
      pathSegments: [],
      title: 'Login screen review',
      revision: request.revision,
      pendingRequestIds: [request.requestId],
    });
    const content = await documents.read({ documentId: request.documentId });
    expect(content.data.content).toContain('Choose the layout and display density.');
    expect(request.status).toBe('pending');
    expect(events.map((event) => event.type)).toContain('catalog-changed');
  });

  it('does not create a second pending question for the same document; the same operation ID returns the same question, different content is a conflict', async () => {
    const { documentId } = await openDocument('a.md', '# A\n');
    const operationId = randomUUID();
    const first = await ask({ documentId, operationId });
    const again = await ask({ documentId, operationId });
    expect(again).toMatchObject({
      replayed: true,
      request: { requestId: first.request.requestId },
    });
    await expect(ask({ documentId })).rejects.toMatchObject({
      code: 'E_PENDING_REQUEST_EXISTS',
      details: { requestId: first.request.requestId },
    });
    const other = { ...questionnaire, title: 'Another question' };
    await expect(
      feedback.create({ cwd: base, questionnaire: JSON.stringify(other), documentId, operationId }),
    ).rejects.toMatchObject({ code: 'E_OPERATION_CONFLICT' });
    expect(feedback.list({}).data.requests).toHaveLength(1);
  });

  it('--view opens the document and asks on that revision; no questions on closed documents or unretained revisions', async () => {
    write('view.md', '# Screen\n');
    const viewed = await ask({ view: 'view.md' });
    expect(documents.list({}).data.documents[0]).toMatchObject({
      documentId: viewed.request.documentId,
      revision: viewed.request.revision,
    });
    const { documentId } = await openDocument('b.md', '# B\n');
    await documents.close({ cwd: base, targets: [documentId] });
    await expect(ask({ documentId })).rejects.toMatchObject({ code: 'E_DOCUMENT_NOT_OPEN' });
    const reopened = await openDocument('b.md', '# B\n');
    await expect(
      ask({ documentId: reopened.documentId, revision: `rev_${'0'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'E_REVISION_UNAVAILABLE' });
  });

  it('FB-002 does not register a questionnaire with duplicate keys or an unsupported shape', async () => {
    await expect(
      feedback.create({
        cwd: base,
        questionnaire: text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      }),
    ).rejects.toMatchObject({
      code: 'E_QUESTIONNAIRE_INVALID',
      details: { reason: 'duplicate-key' },
    });
    await expect(
      feedback.create({
        cwd: base,
        questionnaire: JSON.stringify({ ...questionnaire, $ref: 'https://example.com/q.json' }),
      }),
    ).rejects.toMatchObject({ code: 'E_QUESTIONNAIRE_INVALID' });
    await expect(
      feedback.create({ cwd: base, questionnaire: `${text}${' '.repeat(64 * 1024)}` }),
    ).rejects.toMatchObject({ code: 'E_LIMIT_EXCEEDED' });
    expect(feedback.list({}).data.requests).toEqual([]);
    expect(documents.list({}).data.documents).toEqual([]);
  });
});

describe('FB-004 does not return draft answers to agents', () => {
  it('get, list, and wait results do not include draft answers or the questionnaire', async () => {
    const { request } = await ask();
    await feedback.updateDraft(request.requestId, {
      expectedDraftVersion: 0,
      answers: { layout: 'A' },
    });
    const got = feedback.get({ requestId: request.requestId }).data;
    expect(Object.keys(got).toSorted()).toEqual(
      [
        'acknowledgedAt',
        'cancellation',
        'createdAt',
        'documentId',
        'requestId',
        'revision',
        'status',
        'submission',
        'title',
      ].toSorted(),
    );
    expect(JSON.stringify(feedback.list({}).data)).not.toContain('"A"');
    await expect(
      feedback.wait({ requestId: request.requestId, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT', details: { status: 'pending' } });
    // Included in the fetch for the management UI.
    expect(feedback.getForUi(request.requestId).data.draftAnswers).toEqual({ layout: 'A' });
  });
});

describe('FB-012 / FB-013 / FB-014 submit', () => {
  it('submits the saved draft answers; if the draft changes after confirmation, the stale submit is rejected', async () => {
    const { request } = await ask();
    const flow = await answer(request.requestId);
    await feedback.updateDraft(request.requestId, {
      expectedDraftVersion: flow.draftVersion,
      answers: { ...complete, layout: 'A' },
    });
    await expect(flow.submit()).rejects.toMatchObject({ code: 'E_DRAFT_CONFLICT' });
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
  });

  it('a replay with the same submission ID returns the same result; different conditions are a conflict and the submitted answer is not replaced', async () => {
    const { request } = await ask();
    const flow = await answer(request.requestId);
    const submissionId = `sub_${randomUUID()}`;
    const first = (await flow.submit({ submissionId })).data;
    expect(first.status).toBe('submitted');
    expect(first.submission?.answers).toEqual(complete);
    const storeVersion = store.storeVersion;
    const again = (await flow.submit({ submissionId })).data;
    expect(again.submission).toEqual(first.submission);
    expect(store.storeVersion).toBe(storeVersion);
    await expect(flow.submit({ submissionId, confirmOlderRevision: true })).rejects.toMatchObject({
      code: 'E_SUBMISSION_CONFLICT',
    });
    await expect(flow.submit()).rejects.toMatchObject({ code: 'E_REQUEST_NOT_PENDING' });
    expect(feedback.get({ requestId: request.requestId }).data.submission).toEqual(
      first.submission,
    );
  });

  it('does not submit without required answers; an incomplete draft can still be saved', async () => {
    const { request } = await ask();
    const flow = await answer(request.requestId, { layout: 'A' });
    await expect(flow.submit()).rejects.toMatchObject({
      code: 'E_ANSWER_INVALID',
      details: { issues: [{ field: 'density', code: 'required' }] },
    });
    await expect(
      feedback.updateDraft(request.requestId, {
        expectedDraftVersion: flow.draftVersion,
        answers: { layout: 'C' },
      }),
    ).rejects.toMatchObject({
      code: 'E_ANSWER_INVALID',
      details: { issues: [{ field: 'layout', code: 'enum' }] },
    });
    await expect(
      feedback.updateDraft(request.requestId, {
        expectedDraftVersion: 0,
        answers: { layout: 'B' },
      }),
    ).rejects.toMatchObject({ code: 'E_DRAFT_CONFLICT' });
  });

  it('a submit that failed to persist is not treated as success (stays pending and can be submitted again)', async () => {
    await setup({
      ...nodeStoreFs,
      writeFileDurable: async (path, data, mode) => {
        if (failWrites && path.includes('.tmp-state-'))
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return nodeStoreFs.writeFileDurable(path, data, mode);
      },
    });
    let failWrites = false;
    const { request } = await ask();
    const flow = await answer(request.requestId);
    const submissionId = `sub_${randomUUID()}`;
    failWrites = true;
    await expect(flow.submit({ submissionId })).rejects.toMatchObject({
      code: 'E_STORAGE_WRITE_FAILED',
    });
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
    expect(events.filter((event) => event.status === 'submitted')).toEqual([]);
    failWrites = false;
    expect((await flow.submit({ submissionId })).data.status).toBe('submitted');
  });
});

describe('FB-016 newer revisions and confirming answers to an older revision', () => {
  it('with a newer revision, does not submit without confirmation in the host; a further revision change requires confirming again', async () => {
    const { documentId } = await openDocument('a.md', '# Version 1\n');
    const { request } = await ask({ documentId });
    const flow = await answer(request.requestId);
    write('a.md', '# Version 2\n');
    await documents.refreshFromDisk(documentId);
    const shown = feedback.getForUi(request.requestId).data;
    expect(shown.currentRevision).not.toBe(request.revision);
    // Not confirmed.
    await expect(flow.submit({ currentRevision: shown.currentRevision })).rejects.toMatchObject({
      code: 'E_NEWER_REVISION',
    });
    // The revision changed again after confirmation.
    write('a.md', '# Version 3\n');
    await documents.refreshFromDisk(documentId);
    await expect(
      flow.submit({ currentRevision: shown.currentRevision, confirmOlderRevision: true }),
    ).rejects.toMatchObject({ code: 'E_NEWER_REVISION' });
    const latest = feedback.getForUi(request.requestId).data;
    const submitted = (
      await flow.submit({ currentRevision: latest.currentRevision, confirmOlderRevision: true })
    ).data;
    expect(submitted.submission).toMatchObject({
      revision: request.revision,
      confirmedAgainstOlderRevision: true,
      currentRevisionAtSubmit: latest.currentRevision,
    });
  });
});

describe('FB-017 / FB-018 / FB-019 / FB-020 / FB-021 wait, cancel, acknowledge, and forget', () => {
  it('wait ends on submit, and on timeout leaves the question pending', async () => {
    const { request } = await ask();
    await expect(
      feedback.wait({ requestId: request.requestId, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
    const flow = await answer(request.requestId);
    const waiting = feedback.wait({ requestId: request.requestId, timeoutMs: 5000 });
    const other = feedback.wait({ requestId: request.requestId, timeoutMs: 5000 });
    await flow.submit();
    // Multiple waiters receive the same answer.
    const [a, b] = await Promise.all([waiting, other]);
    expect(a.data.submission).toEqual(b.data.submission);
    expect(a.data.status).toBe('submitted');
  });

  it('closing the document cancels the pending question and notifies waiting requests', async () => {
    const { documentId } = await openDocument('a.md', '# A\n');
    const { request } = await ask({ documentId });
    const waiting = feedback.wait({ requestId: request.requestId, timeoutMs: 5000 });
    await documents.close({ cwd: base, targets: [documentId] });
    const result = (await waiting).data;
    expect(result).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'document_closed' },
    });
    // An explicit cancel returns as is if already cancelled.
    expect(
      (await feedback.cancel({ requestId: request.requestId }, 'agent')).data.cancellation?.reason,
    ).toBe('document_closed');
  });

  it('reading does not acknowledge; acknowledge is explicit and idempotent', async () => {
    const { request } = await ask();
    const submitted = (await (await answer(request.requestId)).submit()).data;
    const submissionId = submitted.submission?.submissionId as string;
    feedback.get({ requestId: request.requestId });
    await feedback.wait({ requestId: request.requestId, timeoutMs: 100 });
    expect(feedback.get({ requestId: request.requestId }).data.acknowledgedAt).toBeNull();
    await expect(
      feedback.ack({ requestId: request.requestId, submissionId: `sub_${randomUUID()}` }),
    ).rejects.toMatchObject({ code: 'E_SUBMISSION_CONFLICT' });
    const first = (await feedback.ack({ requestId: request.requestId, submissionId })).data;
    const again = (await feedback.ack({ requestId: request.requestId, submissionId })).data;
    expect(first.acknowledgedAt).not.toBeNull();
    expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
    expect(feedback.getForUi(request.requestId).data.acknowledgedAt).toBe(first.acknowledgedAt);
    const { request: other } = await ask({ view: (write('p.md', '# P\n'), 'p.md') });
    await expect(feedback.ack({ requestId: other.requestId, submissionId })).rejects.toMatchObject({
      code: 'E_NOT_SUBMITTED',
    });
  });

  it('draft answers of a submitted question cannot be changed, and a pending question cannot be forgotten', async () => {
    const { request } = await ask();
    await expect(
      feedback.forget({ requestId: request.requestId, confirmed: true }),
    ).rejects.toMatchObject({
      code: 'E_REQUEST_PENDING',
    });
    const flow = await answer(request.requestId);
    await flow.submit();
    await expect(
      feedback.updateDraft(request.requestId, {
        expectedDraftVersion: flow.draftVersion,
        answers: {},
      }),
    ).rejects.toMatchObject({ code: 'E_REQUEST_NOT_PENDING' });
    await expect(feedback.cancel({ requestId: request.requestId }, 'agent')).rejects.toMatchObject({
      code: 'E_REQUEST_NOT_PENDING',
    });
  });

  it('forgets only the finished question record; originals, documents, and other questions remain, and unpinned revisions can be pruned', async () => {
    const { documentId } = await openDocument('a.md', '# Version 1\n');
    const { request } = await ask({ documentId });
    await (await answer(request.requestId)).submit();
    const { request: other } = await ask();
    for (const version of [2, 3, 4]) {
      write('a.md', `# Version ${String(version)}\n`);
      await documents.refreshFromDisk(documentId);
    }
    const revisionsOf = () =>
      store.payload.documents[documentId]?.revisions.map((entry) => entry.revision) ?? [];
    // A revision pinned by a question remains even if it is not recent.
    expect(revisionsOf()).toContain(request.revision);
    await expect(
      feedback.forget({ requestId: request.requestId, confirmed: false }),
    ).rejects.toMatchObject({
      code: 'E_CONFIRMATION_REQUIRED',
    });
    await feedback.forget({ requestId: request.requestId, confirmed: true });
    await expect(
      Promise.resolve().then(() => feedback.get({ requestId: request.requestId })),
    ).rejects.toMatchObject({
      code: 'E_REQUEST_NOT_FOUND',
    });
    expect(feedback.get({ requestId: other.requestId }).data.status).toBe('pending');
    expect(store.payload.documents[documentId]?.isOpen).toBe(true);
    expect(existsSync(join(base, 'a.md'))).toBe(true);
    // Revisions within 5 minutes remain per the rules (not removed immediately when unpinned).
    expect(findIntegrityProblem(store.payload)).toBeNull();
  });
});

describe('SYS-015 storage limit and pinned revisions', () => {
  it('new operations beyond the limit fail, and content of revisions pinned by questions is not removed', async () => {
    await setup(nodeStoreFs, 4096);
    const { documentId } = await openDocument('a.md', `# Version 1\n${'a'.repeat(1000)}\n`);
    const { request } = await ask({ documentId });
    const pinnedBlob = store.payload.documents[documentId]?.revisions.find(
      (entry) => entry.revision === request.revision,
    )?.sourceSha256 as string;
    write('a.md', `# Version 2\n${'b'.repeat(4000)}\n`);
    await expect(documents.open({ cwd: base, paths: ['a.md'] })).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'blobStoreBytes' },
    });
    await store.collectGarbage();
    expect(readdirSync(join(base, 'home', 'blobs'))).toContain(pinnedBlob);
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
  });
});

describe('file operation failures during the submit commit', () => {
  it('whichever file operation fails, the restored question is either pending or submitted (with answers)', async () => {
    // Build a state with saved draft answers and count the file operations in the submit commit.
    const seed = join(base, 'seed');
    const seedStore = await StateStore.open({ root: seed, fs: nodeStoreFs });
    const seedDocuments = new DocumentService({
      store: seedStore,
      cursors: createCursorCodec(randomBytes(32)),
    });
    const seedFeedback = new FeedbackService({ store: seedStore, documents: seedDocuments });
    const { request } = (await seedFeedback.create({ cwd: base, questionnaire: text })).data;
    await seedFeedback.updateDraft(request.requestId, {
      expectedDraftVersion: 0,
      answers: complete,
    });
    const params = {
      submissionId: `sub_${randomUUID()}`,
      expectedDraftVersion: 1,
      revision: request.revision,
      currentRevision: request.revision,
    };
    let operations = 0;
    const counting: StoreFs = Object.fromEntries(
      Object.entries(nodeStoreFs).map(([name, operation]) => [
        name,
        (...args: unknown[]) => {
          operations += 1;
          return (operation as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as StoreFs;
    const probeRoot = join(base, 'probe');
    cpSync(seed, probeRoot, { recursive: true });
    const probe = await StateStore.open({ root: probeRoot, fs: counting });
    operations = 0;
    await new FeedbackService({
      store: probe,
      documents: new DocumentService({ store: probe, cursors: createCursorCodec(randomBytes(32)) }),
    }).submit(request.requestId, params);
    expect(operations).toBeGreaterThan(3);

    const outcomes = new Set<string>();
    for (let crashAt = 1; crashAt <= operations; crashAt += 1) {
      const root = join(base, `crash-${String(crashAt)}`);
      cpSync(seed, root, { recursive: true });
      let count = 0;
      let armed = false;
      const crashing: StoreFs = Object.fromEntries(
        Object.entries(nodeStoreFs).map(([name, operation]) => [
          name,
          (...args: unknown[]) => {
            if (armed) count += 1;
            if (armed && count === crashAt)
              throw new Error(`Stopped right before operation ${String(crashAt)}`);
            return (operation as (...a: unknown[]) => unknown)(...args);
          },
        ]),
      ) as unknown as StoreFs;
      const crashed = await StateStore.open({ root, fs: crashing });
      armed = true;
      await new FeedbackService({
        store: crashed,
        documents: new DocumentService({
          store: crashed,
          cursors: createCursorCodec(randomBytes(32)),
        }),
      })
        .submit(request.requestId, params)
        .catch(() => undefined);
      const restored = (await StateStore.open({ root, fs: nodeStoreFs })).payload.feedbackRequests[
        request.requestId
      ];
      const summary = {
        status: restored?.status,
        submission: restored?.submission
          ? { submissionId: restored.submission.submissionId, answers: restored.submission.answers }
          : null,
        draftAnswers: restored?.draftAnswers,
      };
      expect([
        { status: 'pending', submission: null, draftAnswers: complete },
        {
          status: 'submitted',
          submission: { submissionId: params.submissionId, answers: complete },
          draftAnswers: complete,
        },
      ]).toContainEqual(summary);
      outcomes.add(restored?.status ?? 'missing');
    }
    expect([...outcomes].toSorted()).toEqual(['pending', 'submitted']);
  });
});

describe('SYS-009 process killed during a commit', () => {
  const fixture = fileURLToPath(new URL('crash-commit.fixture.ts', import.meta.url));

  // Runs the operation in a child process on a copy of the seed state. Kills it without cleanup right before
  // the Nth file operation (0 runs to the end and returns the list of file operations performed).
  const runIn = (seed: string, root: string, crashAt: number, operation: string, params: unknown) =>
    new Promise<{ signal: NodeJS.Signals | null; stdout: string }>((resolve) => {
      cpSync(seed, root, { recursive: true });
      const child = spawn(
        process.execPath,
        [fixture, root, String(crashAt), operation, JSON.stringify(params)],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('close', (_code, signal) => resolve({ signal, stdout }));
    });

  // Kills once right before each file operation and inspects the restored state.
  async function killAtEachStep<T>(
    seed: string,
    operation: string,
    params: unknown,
    inspect: (payload: StateStore['payload']) => T,
  ): Promise<{ steps: string[]; restored: T[] }> {
    const probe = await runIn(seed, join(base, `${operation}-probe`), 0, operation, params);
    const steps = JSON.parse(probe.stdout) as string[];
    const restored = await Promise.all(
      steps.map(async (_, index) => {
        const root = join(base, `${operation}-kill-${String(index + 1)}`);
        const { signal } = await runIn(seed, root, index + 1, operation, params);
        expect(signal).toBe('SIGKILL');
        // If a referenced blob is missing, opening fails with E_STATE_CORRUPT.
        const reopened = await StateStore.open({ root, fs: nodeStoreFs });
        expect(findIntegrityProblem(reopened.payload)).toBeNull();
        const result = inspect(reopened.payload);
        await reopened.close();
        return result;
      }),
    );
    return { steps, restored };
  }

  it('submit: wherever killed around the metadata rename and directory sync, the restored question is pending or submitted', async () => {
    const seed = join(base, 'seed');
    const seedStore = await StateStore.open({ root: seed, fs: nodeStoreFs });
    const seedFeedback = new FeedbackService({
      store: seedStore,
      documents: new DocumentService({
        store: seedStore,
        cursors: createCursorCodec(randomBytes(32)),
      }),
    });
    const { request } = (await seedFeedback.create({ cwd: base, questionnaire: text })).data;
    await seedFeedback.updateDraft(request.requestId, {
      expectedDraftVersion: 0,
      answers: complete,
    });
    await seedStore.close();
    const submissionId = `sub_${randomUUID()}`;
    const { steps, restored } = await killAtEachStep(
      seed,
      'submit',
      {
        requestId: request.requestId,
        params: {
          submissionId,
          expectedDraftVersion: 1,
          revision: request.revision,
          currentRevision: request.revision,
        },
      },
      (payload) => {
        const record = payload.feedbackRequests[request.requestId];
        return {
          status: record?.status,
          submission: record?.submission
            ? { submissionId: record.submission.submissionId, answers: record.submission.answers }
            : null,
        };
      },
    );
    // Submit creates no new blob. It goes through the state temp file, rename, and directory sync.
    expect(steps).toContain('rename:state');
    expect(steps).toContain('syncDirectory:state');
    expect(steps.some((step) => step.endsWith(':blob'))).toBe(false);
    for (const outcome of restored) {
      expect([
        { status: 'pending', submission: null },
        { status: 'submitted', submission: { submissionId, answers: complete } },
      ]).toContainEqual(outcome);
    }
    expect(new Set(restored.map((outcome) => outcome.status))).toEqual(
      new Set(['pending', 'submitted']),
    );
  });

  it('create: wherever killed, including right after the blob is created, the question and the document blob are both present or both absent', async () => {
    const seed = join(base, 'seed');
    await (await StateStore.open({ root: seed, fs: nodeStoreFs })).close();
    const { steps, restored } = await killAtEachStep(
      seed,
      'create',
      { cwd: base, questionnaire: text },
      (payload) => ({
        requests: Object.values(payload.feedbackRequests).map((record) => ({
          status: record.status,
          // The document with the revision pinned by the question exists and its content is readable (blob existence is checked on open).
          pinned:
            payload.documents[record.documentId]?.revisions.some(
              (entry) => entry.revision === record.revision,
            ) ?? false,
        })),
        documents: Object.keys(payload.documents).length,
      }),
    );
    // The question document's blob is written to a temp file, renamed, the blob directory synced, then the state is replaced.
    const blobCreated = steps.indexOf('rename:blob');
    expect(blobCreated).toBeGreaterThanOrEqual(0);
    expect(steps[blobCreated + 1]).toBe('syncDirectory:blob-dir');
    expect(steps.indexOf('rename:state')).toBeGreaterThan(blobCreated + 1);
    for (const outcome of restored) {
      expect([
        { requests: [], documents: 0 },
        { requests: [{ status: 'pending', pinned: true }], documents: 1 },
      ]).toContainEqual(outcome);
    }
    // Killed right after the blob is created (right before the directory sync), there is no question yet.
    expect(restored[blobCreated + 1]).toEqual({ requests: [], documents: 0 });
    expect(restored.at(-1)).toEqual({
      requests: [{ status: 'pending', pinned: true }],
      documents: 1,
    });
  });
});
