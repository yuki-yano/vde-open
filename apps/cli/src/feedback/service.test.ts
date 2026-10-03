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

const complete = { layout: 'B', density: 'compact', comment: '説明を短く' };

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

describe('FB-005 / FB-006 質問の作成', () => {
  it('文書の指定がなければ、質問のtitleと説明の文書を作り、その版に固定する', async () => {
    const { request } = await ask();
    const listed = documents.list({}).data.documents;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      documentId: request.documentId,
      sourceKind: 'generated',
      displayPath: null,
      pathSegments: [],
      title: 'ログイン画面の確認',
      revision: request.revision,
      pendingRequestIds: [request.requestId],
    });
    const content = await documents.read({ documentId: request.documentId });
    expect(content.data.content).toContain('採用案と表示密度を選んでください。');
    expect(request.status).toBe('pending');
    expect(events.map((event) => event.type)).toContain('catalog-changed');
  });

  it('同じ文書へ回答待ちの質問を重ねて作らない。同じoperation IDは同じ質問、内容が違えば競合', async () => {
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
    const other = { ...questionnaire, title: '別の質問' };
    await expect(
      feedback.create({ cwd: base, questionnaire: JSON.stringify(other), documentId, operationId }),
    ).rejects.toMatchObject({ code: 'E_OPERATION_CONFLICT' });
    expect(feedback.list({}).data.requests).toHaveLength(1);
  });

  it('--viewは文書を開いてから、その版へ質問する。閉じた文書や保持していない版へは質問しない', async () => {
    write('view.md', '# 画面\n');
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

  it('FB-002 重複したkeyや対応しない形の質問定義は、登録しない', async () => {
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

describe('FB-004 Agentへ回答案を返さない', () => {
  it('get・list・waitの結果に、回答案と質問定義を含めない', async () => {
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
    // 管理UI向けの取得には含まれる。
    expect(feedback.getForUi(request.requestId).data.draftAnswers).toEqual({ layout: 'A' });
  });
});

describe('FB-012 / FB-013 / FB-014 送信', () => {
  it('確定する内容は保存済みの回答案。確認した後に回答案が変われば、古い送信を拒否する', async () => {
    const { request } = await ask();
    const flow = await answer(request.requestId);
    await feedback.updateDraft(request.requestId, {
      expectedDraftVersion: flow.draftVersion,
      answers: { ...complete, layout: 'A' },
    });
    await expect(flow.submit()).rejects.toMatchObject({ code: 'E_DRAFT_CONFLICT' });
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
  });

  it('同じsubmission IDの再送は同じ結果。条件が違えば競合にし、確定した回答を置き換えない', async () => {
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

  it('必須の回答がなければ送信しない。回答案は未完成でも保存できる', async () => {
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

  it('保存できなかった送信は、成功として扱わない（回答待ちのまま、再送で確定できる）', async () => {
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

describe('FB-016 新しい版と、旧版への回答の確認', () => {
  it('新しい版があれば、本体での確認なしには送信しない。確認した後に版が変われば確認し直す', async () => {
    const { documentId } = await openDocument('a.md', '# 版1\n');
    const { request } = await ask({ documentId });
    const flow = await answer(request.requestId);
    write('a.md', '# 版2\n');
    await documents.refreshFromDisk(documentId);
    const shown = feedback.getForUi(request.requestId).data;
    expect(shown.currentRevision).not.toBe(request.revision);
    // 確認していない。
    await expect(flow.submit({ currentRevision: shown.currentRevision })).rejects.toMatchObject({
      code: 'E_NEWER_REVISION',
    });
    // 確認した後に、さらに版が変わった。
    write('a.md', '# 版3\n');
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

describe('FB-017 / FB-018 / FB-019 / FB-020 / FB-021 待機・中止・取得済み・削除', () => {
  it('待機は回答の確定で終わり、時間切れでは質問を回答待ちのまま残す', async () => {
    const { request } = await ask();
    await expect(
      feedback.wait({ requestId: request.requestId, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
    const flow = await answer(request.requestId);
    const waiting = feedback.wait({ requestId: request.requestId, timeoutMs: 5000 });
    const other = feedback.wait({ requestId: request.requestId, timeoutMs: 5000 });
    await flow.submit();
    // 複数の待機が、同じ回答を受け取る。
    const [a, b] = await Promise.all([waiting, other]);
    expect(a.data.submission).toEqual(b.data.submission);
    expect(a.data.status).toBe('submitted');
  });

  it('文書を閉じると回答待ちの質問は中止になり、待っている要求にも伝わる', async () => {
    const { documentId } = await openDocument('a.md', '# A\n');
    const { request } = await ask({ documentId });
    const waiting = feedback.wait({ requestId: request.requestId, timeoutMs: 5000 });
    await documents.close({ cwd: base, targets: [documentId] });
    const result = (await waiting).data;
    expect(result).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'document_closed' },
    });
    // 明示的な中止は、中止済みならそのまま返す。
    expect(
      (await feedback.cancel({ requestId: request.requestId }, 'agent')).data.cancellation?.reason,
    ).toBe('document_closed');
  });

  it('読むだけでは取得済みにしない。取得済みの印は明示的に付け、何度付けても同じ', async () => {
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

  it('回答済みの質問の回答案は変えられず、回答待ちの質問は消せない', async () => {
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

  it('終わった質問の記録だけを消す。原本・文書・ほかの質問は残し、固定が外れた版は整理できる', async () => {
    const { documentId } = await openDocument('a.md', '# 版1\n');
    const { request } = await ask({ documentId });
    await (await answer(request.requestId)).submit();
    const { request: other } = await ask();
    for (const version of [2, 3, 4]) {
      write('a.md', `# 版${String(version)}\n`);
      await documents.refreshFromDisk(documentId);
    }
    const revisionsOf = () =>
      store.payload.documents[documentId]?.revisions.map((entry) => entry.revision) ?? [];
    // 質問が固定している版は、直近の版でなくても残る。
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
    // 5分以内の版は、規則どおり残る（固定が外れても、すぐには消さない）。
    expect(findIntegrityProblem(store.payload)).toBeNull();
  });
});

describe('SYS-015 保存容量の上限と固定した版', () => {
  it('上限を超える新しい操作はerrorにし、質問が固定している版の内容は消さない', async () => {
    await setup(nodeStoreFs, 4096);
    const { documentId } = await openDocument('a.md', `# 版1\n${'a'.repeat(1000)}\n`);
    const { request } = await ask({ documentId });
    const pinnedBlob = store.payload.documents[documentId]?.revisions.find(
      (entry) => entry.revision === request.revision,
    )?.sourceSha256 as string;
    write('a.md', `# 版2\n${'b'.repeat(4000)}\n`);
    await expect(documents.open({ cwd: base, paths: ['a.md'] })).rejects.toMatchObject({
      code: 'E_LIMIT_EXCEEDED',
      details: { limit: 'blobStoreBytes' },
    });
    await store.collectGarbage();
    expect(readdirSync(join(base, 'home', 'blobs'))).toContain(pinnedBlob);
    expect(feedback.get({ requestId: request.requestId }).data.status).toBe('pending');
  });
});

describe('送信のcommit途中でのfile操作の失敗', () => {
  it('どのfile操作が失敗しても、復元後の質問は「回答待ち」か「回答済み（回答を含む）」のどちらか', async () => {
    // 回答案まで保存した状態を作り、送信のcommitで行うfile操作を数える。
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
            if (armed && count === crashAt) throw new Error(`操作 ${String(crashAt)} の直前で停止`);
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

describe('SYS-009 commitの途中でのprocessの停止', () => {
  const fixture = fileURLToPath(new URL('crash-commit.fixture.ts', import.meta.url));

  // seedのstateを写した場所で、子processに操作をさせる。指定した番目のfile操作の直前で、
  // 後始末をせずにkillする（0なら止めずに最後まで行い、行ったfile操作の一覧を返す）。
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

  // すべてのfile操作の直前で1回ずつkillし、復元したstateを調べる。
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
        // 参照するblobがなければ、開く時点でE_STATE_CORRUPTになる。
        const reopened = await StateStore.open({ root, fs: nodeStoreFs });
        expect(findIntegrityProblem(reopened.payload)).toBeNull();
        const result = inspect(reopened.payload);
        await reopened.close();
        return result;
      }),
    );
    return { steps, restored };
  }

  it('送信: metadataのrenameとdirectoryのsyncの前後のどこでkillされても、復元後は回答待ちか回答済み', async () => {
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
    // 送信は新しいblobを作らない。stateの一時file・rename・directoryのsyncを通る。
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

  it('質問の作成: blobの作成の直後を含め、どこでkillされても、質問と文書のblobは両方あるか両方ないか', async () => {
    const seed = join(base, 'seed');
    await (await StateStore.open({ root: seed, fs: nodeStoreFs })).close();
    const { steps, restored } = await killAtEachStep(
      seed,
      'create',
      { cwd: base, questionnaire: text },
      (payload) => ({
        requests: Object.values(payload.feedbackRequests).map((record) => ({
          status: record.status,
          // 質問が固定した版の文書があり、その版の内容が読める（開く時点でblobの存在を確かめている）。
          pinned:
            payload.documents[record.documentId]?.revisions.some(
              (entry) => entry.revision === record.revision,
            ) ?? false,
        })),
        documents: Object.keys(payload.documents).length,
      }),
    );
    // 質問の文書のblobを、一時fileへ書いてrenameし、blobのdirectoryをsyncしてから、stateを置き換える。
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
    // blobを作った直後（directoryのsyncの直前）のkillでは、まだ質問はない。
    expect(restored[blobCreated + 1]).toEqual({ requests: [], documents: 0 });
    expect(restored.at(-1)).toEqual({
      requests: [{ status: 'pending', pinned: true }],
      documents: 1,
    });
  });
});
