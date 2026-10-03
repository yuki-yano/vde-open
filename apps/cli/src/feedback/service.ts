import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  canonicalJson,
  feedbackAckParamsSchema,
  feedbackCreateParamsSchema,
  feedbackDraftParamsSchema,
  feedbackForgetParamsSchema,
  feedbackIdParamsSchema,
  feedbackListParamsSchema,
  feedbackSubmitParamsSchema,
  feedbackWaitParamsSchema,
  LIMITS,
  parseStrictJson,
  questionnaireSchema,
  StrictJsonError,
  utf8Length,
  validateAnswers,
  VdeError,
  type AnswerIssue,
  type FeedbackCreateResult,
  type FeedbackForAgent,
  type FeedbackForUi,
  type FeedbackListResult,
  type Questionnaire,
} from '@vde-open/shared';

import { canonicalizePath } from '../documents/source-reader.ts';
import {
  pruneRevisions,
  type DocumentEvent,
  type DocumentService,
  type ServiceResult,
} from '../documents/service.ts';
import {
  pinnedRevisions,
  type FeedbackRecord,
  type StatePayload,
} from '../persistence/state-schema.ts';
import type { StateStore } from '../persistence/state-store.ts';

export interface FeedbackServiceOptions {
  store: StateStore;
  documents: DocumentService;
  now?: () => Date;
  // commitが成功した後にだけ呼ばれる。IDと状態だけを運ぶ。
  emit?: (event: DocumentEvent) => void;
}

interface Waiter {
  wake: () => void;
  fail: (error: Error) => void;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function notFound(requestId: string): VdeError {
  return new VdeError('E_REQUEST_NOT_FOUND', '質問が見つかりません。', { requestId });
}

function answerError(issues: AnswerIssue[]): VdeError {
  // 値は含めない。回答に秘密が書かれていても、errorやlogへ写さない。
  return new VdeError('E_ANSWER_INVALID', '回答が質問の条件に合いません。', { issues });
}

// 質問定義の原文を読む。重複したkeyと`__proto__`を拒否し、決まった形だけを受け付ける（仕様11.2）。
export function parseQuestionnaire(text: string): Questionnaire {
  const bytes = utf8Length(text);
  if (bytes > LIMITS.questionnaireBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', '質問定義が大きすぎます。', {
      limit: 'questionnaireBytes',
      max: LIMITS.questionnaireBytes,
      actual: bytes,
    });
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new VdeError('E_QUESTIONNAIRE_INVALID', '質問定義をJSONとして読めません。', {
        reason: error.reason,
        pointer: error.pointer,
      });
    }
    throw error;
  }
  const parsed = questionnaireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VdeError('E_QUESTIONNAIRE_INVALID', '質問定義が、受け付ける形ではありません。', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

// 質問と回答（仕様11）。質問は作ったときの文書の版に固定し、回答は管理UIの送信でだけ確定する。
// Agentへは、確定した回答だけを返す（回答案は返さない）。
export class FeedbackService {
  readonly #store: StateStore;
  readonly #documents: DocumentService;
  readonly #now: () => Date;
  readonly #emit: (event: DocumentEvent) => void;
  readonly #waiters = new Map<string, Set<Waiter>>();
  #closed = false;

  constructor(options: FeedbackServiceOptions) {
    this.#store = options.store;
    this.#documents = options.documents;
    this.#now = options.now ?? (() => new Date());
    this.#emit = options.emit ?? (() => undefined);
  }

  #toAgent(record: FeedbackRecord): FeedbackForAgent {
    return structuredClone({
      requestId: record.requestId,
      documentId: record.documentId,
      revision: record.revision,
      title: record.questionnaire.title,
      status: record.status,
      createdAt: record.createdAt,
      submission: record.submission,
      cancellation: record.cancellation,
      acknowledgedAt: record.acknowledgedAt,
    });
  }

  #toUi(state: StatePayload, record: FeedbackRecord): FeedbackForUi {
    const document = state.documents[record.documentId];
    return {
      ...this.#toAgent(record),
      questionnaire: structuredClone(record.questionnaire),
      renderMode: record.renderMode,
      draftVersion: record.draftVersion,
      draftAnswers: structuredClone(record.draftAnswers),
      currentRevision: document?.currentRevision ?? null,
      documentOpen: document?.isOpen ?? false,
    };
  }

  #require(state: StatePayload, requestId: string): FeedbackRecord {
    const record = Object.hasOwn(state.feedbackRequests, requestId)
      ? state.feedbackRequests[requestId]
      : undefined;
    if (!record) throw notFound(requestId);
    return record;
  }

  #result<T>(data: T): ServiceResult<T> {
    return { data, catalogVersion: this.#store.payload.catalogVersion, warnings: [] };
  }

  // 質問の状態が変わったことを、通知と、回答を待っている処理へ伝える。
  #changed(record: FeedbackRecord): void {
    this.#emit({
      type: 'feedback-changed',
      requestId: record.requestId,
      documentId: record.documentId,
      status: record.status,
      draftVersion: record.draftVersion,
      acknowledged: record.acknowledgedAt !== null,
    });
    this.wake(record.requestId);
  }

  // 質問の状態が、このservice以外（文書を閉じたとき）で変わったときにも呼ぶ。
  wake(requestId: string): void {
    for (const waiter of this.#waiters.get(requestId) ?? []) waiter.wake();
  }

  async create(rawParams: unknown): Promise<ServiceResult<FeedbackCreateResult>> {
    const params = feedbackCreateParamsSchema.parse(rawParams);
    const questionnaire = parseQuestionnaire(params.questionnaire);
    const questionnaireHash = sha256(canonicalJson(questionnaire));
    // 同じoperation IDの再送かどうかは、質問の内容と、質問する先で決める。
    const viewPath =
      params.view === undefined ? null : await canonicalizePath(resolve(params.cwd, params.view));
    const target =
      params.documentId !== undefined
        ? { kind: 'document', documentId: params.documentId, revision: params.revision ?? null }
        : viewPath !== null
          ? {
              kind: 'view',
              path: viewPath,
              htmlMode: params.htmlMode ?? null,
              assetsRoot: params.assetsRoot ?? null,
              assets: params.assets,
            }
          : { kind: 'generated' };
    const operationDigest =
      params.operationId === undefined
        ? null
        : sha256(canonicalJson({ target, questionnaireHash }));
    const replay = (state: StatePayload): FeedbackRecord | null => {
      if (params.operationId === undefined) return null;
      const existing = Object.values(state.feedbackRequests).find(
        (record) => record.operationId === params.operationId,
      );
      if (!existing) return null;
      if (existing.operationDigest !== operationDigest) {
        throw new VdeError(
          'E_OPERATION_CONFLICT',
          '同じoperation IDで、内容の違う質問が作られています。',
          { requestId: existing.requestId },
        );
      }
      return existing;
    };
    const replayed = replay(this.#store.payload);
    if (replayed) return this.#result({ request: this.#toAgent(replayed), replayed: true });

    // --viewは、文書を開いてから、その版に質問を固定する。
    let viewDocument: { documentId: string; revision: string } | null = null;
    if (params.view !== undefined) {
      const opened = await this.#documents.open({
        cwd: params.cwd,
        paths: [params.view],
        ...(params.htmlMode === undefined ? {} : { htmlMode: params.htmlMode }),
        ...(params.assetsRoot === undefined ? {} : { assetsRoot: params.assetsRoot }),
        assets: params.assets,
      });
      const [document] = opened.data.documents;
      if (opened.data.documents.length !== 1 || !document?.revision) {
        throw new VdeError('E_INVALID_ARGUMENT', '--viewには、文書を1件だけ指定してください。', {
          documents: opened.data.documents.length,
        });
      }
      viewDocument = { documentId: document.documentId, revision: document.revision };
    }

    let generated = false;
    const outcome = await this.#store.transaction((tx) => {
      const state = tx.state;
      const again = replay(state);
      if (again) return { record: again, replayed: true };
      const timestamp = this.#now().toISOString();
      let documentId: string;
      let revision: string | null;
      if (params.documentId !== undefined) {
        documentId = params.documentId;
        revision = params.revision ?? null;
      } else if (viewDocument !== null) {
        ({ documentId, revision } = viewDocument);
      } else {
        // 質問だけのときは、質問のtitleと説明を内容とする文書を作る。
        const text = `# ${questionnaire.title}\n\n${questionnaire.instructions ?? ''}\n`;
        documentId = this.#documents.createGenerated(tx, { title: questionnaire.title, text });
        revision = null;
        generated = true;
      }
      const document = state.documents[documentId];
      if (!document) {
        throw new VdeError('E_DOCUMENT_NOT_FOUND', '文書が見つかりません。', { documentId });
      }
      if (!document.isOpen) {
        throw new VdeError('E_DOCUMENT_NOT_OPEN', '文書は開かれていません。', { documentId });
      }
      const pinned = revision ?? document.currentRevision;
      if (pinned === null || !document.revisions.some((entry) => entry.revision === pinned)) {
        throw new VdeError('E_REVISION_UNAVAILABLE', '指定した版は保持されていません。', {
          documentId,
          revision: pinned,
        });
      }
      // 1つの文書に、回答待ちの質問は1件だけ（仕様11.1）。
      const pending = Object.values(state.feedbackRequests).find(
        (record) => record.documentId === documentId && record.status === 'pending',
      );
      if (pending) {
        throw new VdeError(
          'E_PENDING_REQUEST_EXISTS',
          'この文書には、回答待ちの質問があります。作り直すときは、先に中止してください。',
          { documentId, requestId: pending.requestId },
        );
      }
      const requestId = `req_${randomUUID()}`;
      const record: FeedbackRecord = {
        requestId,
        documentId,
        revision: pinned,
        // 表示方法も、質問を作ったときのものに固定する（仕様11.4）。scriptの実行を許可済みの
        // interactiveのHTMLだけが、HTMLから回答案を送れる質問になる。
        renderMode: this.#documents.interactiveAllowed(documentId) ? 'interactive' : 'static',
        questionnaireHash,
        questionnaire,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        operationId: params.operationId ?? null,
        operationDigest,
        draftVersion: 0,
        draftAnswers: {},
        submission: null,
        submissionDigest: null,
        cancellation: null,
        acknowledgedAt: null,
      };
      state.feedbackRequests[requestId] = record;
      return { record: structuredClone(record), replayed: false };
    });
    if (!outcome.replayed) {
      if (generated) this.#emit({ type: 'catalog-changed' });
      this.#changed(outcome.record);
    }
    return this.#result({ request: this.#toAgent(outcome.record), replayed: outcome.replayed });
  }

  list(rawParams: unknown): ServiceResult<FeedbackListResult> {
    const params = feedbackListParamsSchema.parse(rawParams ?? {});
    const requests = Object.values(this.#store.payload.feedbackRequests)
      .filter((record) => params.status === undefined || record.status === params.status)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => this.#toAgent(record));
    return this.#result({ requests });
  }

  // Agent向けの取得。読むだけで、取得済みの印は付けない（仕様11.3）。
  get(rawParams: unknown): ServiceResult<FeedbackForAgent> {
    const { requestId } = feedbackIdParamsSchema.parse(rawParams);
    return this.#result(this.#toAgent(this.#require(this.#store.payload, requestId)));
  }

  // 回答が確定するか、中止されるまで待つ。時間切れでも、質問は回答待ちのまま（仕様11.3）。
  wait(rawParams: unknown): Promise<ServiceResult<FeedbackForAgent>> {
    const params = feedbackWaitParamsSchema.parse(rawParams);
    const settled = () => {
      const record = this.#require(this.#store.payload, params.requestId);
      return record.status === 'pending' ? null : record;
    };
    const done = settled();
    if (done) return Promise.resolve(this.#result(this.#toAgent(done)));
    if (this.#closed) {
      return Promise.reject(new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。'));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiters = this.#waiters.get(params.requestId) ?? new Set<Waiter>();
      this.#waiters.set(params.requestId, waiters);
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#waiters.delete(params.requestId);
      };
      const waiter: Waiter = {
        wake: () => {
          try {
            const record = settled();
            if (!record) return;
            finish();
            resolvePromise(this.#result(this.#toAgent(record)));
          } catch (error) {
            finish();
            rejectPromise(error as Error);
          }
        },
        fail: (error) => {
          finish();
          rejectPromise(error);
        },
      };
      const timer = setTimeout(() => {
        waiter.fail(
          new VdeError('E_TIMEOUT', '回答を待つ時間が過ぎました。質問は回答待ちのままです。', {
            requestId: params.requestId,
            status: 'pending',
          }),
        );
      }, params.timeoutMs);
      waiters.add(waiter);
    });
  }

  // 回答を取得して処理したことの印。何度呼んでも同じ結果になる。
  async ack(rawParams: unknown): Promise<ServiceResult<FeedbackForAgent>> {
    const params = feedbackAckParamsSchema.parse(rawParams);
    const outcome = await this.#store.transaction((tx) => {
      const record = this.#require(tx.state, params.requestId);
      if (record.status !== 'submitted' || record.submission === null) {
        throw new VdeError('E_NOT_SUBMITTED', 'この質問には、確定した回答がありません。', {
          requestId: params.requestId,
          status: record.status,
        });
      }
      if (record.submission.submissionId !== params.submissionId) {
        throw new VdeError('E_SUBMISSION_CONFLICT', '回答のIDが一致しません。', {
          requestId: params.requestId,
        });
      }
      if (record.acknowledgedAt !== null)
        return { record: structuredClone(record), changed: false };
      record.acknowledgedAt = this.#now().toISOString();
      record.updatedAt = record.acknowledgedAt;
      return { record: structuredClone(record), changed: true };
    });
    if (outcome.changed) this.#changed(outcome.record);
    return this.#result(this.#toAgent(outcome.record));
  }

  // 回答待ちの質問を中止する。中止済みなら、そのまま返す。回答済みの質問は中止できない。
  async cancel(
    rawParams: unknown,
    actor: 'agent' | 'user',
  ): Promise<ServiceResult<FeedbackForAgent>> {
    const { requestId } = feedbackIdParamsSchema.parse(rawParams);
    const outcome = await this.#store.transaction((tx) => {
      const record = this.#require(tx.state, requestId);
      if (record.status === 'cancelled') return { record: structuredClone(record), changed: false };
      if (record.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'この質問には、すでに回答があります。', {
          requestId,
          status: record.status,
        });
      }
      const timestamp = this.#now().toISOString();
      record.status = 'cancelled';
      record.cancellation = {
        cancelledAt: timestamp,
        reason: actor === 'agent' ? 'agent_cancelled' : 'user_cancelled',
      };
      record.updatedAt = timestamp;
      return { record: structuredClone(record), changed: true };
    });
    if (outcome.changed) this.#changed(outcome.record);
    return this.#result(this.#toAgent(outcome.record));
  }

  // 終わった質問の記録を消す。回答待ちは消せない。原本・文書・ほかの質問には触れない（仕様7.3）。
  async forget(rawParams: unknown): Promise<ServiceResult<{ requestId: string; forgotten: true }>> {
    const params = feedbackForgetParamsSchema.parse(rawParams);
    if (!params.confirmed) {
      throw new VdeError('E_CONFIRMATION_REQUIRED', '消すには--yesを指定してください。', {
        requestId: params.requestId,
      });
    }
    await this.#store.transaction((tx) => {
      const state = tx.state;
      const record = this.#require(state, params.requestId);
      if (record.status === 'pending') {
        throw new VdeError(
          'E_REQUEST_PENDING',
          '回答待ちの質問は消せません。先に中止してください。',
          {
            requestId: params.requestId,
          },
        );
      }
      delete state.feedbackRequests[params.requestId];
      // この質問だけが固定していた版を、通常の規則で整理できるようにする。
      const document = state.documents[record.documentId];
      if (document) {
        document.revisions = pruneRevisions(
          document.revisions,
          this.#now().getTime(),
          pinnedRevisions(state, record.documentId),
        );
      }
    });
    // 参照されなくなった保存済みの内容を消す。失敗しても、記録の削除は確定している。
    await this.#store.collectGarbage().catch(() => 0);
    return this.#result({ requestId: params.requestId, forgotten: true });
  }

  // 管理UI向けの取得。質問定義と回答案を含む。
  getForUi(requestId: string): ServiceResult<FeedbackForUi> {
    const state = this.#store.payload;
    return this.#result(this.#toUi(state, this.#require(state, requestId)));
  }

  // 回答案を置き換える。もとにした版が違えば、上書きせずに競合を返す（仕様11.6）。
  // authorizeは、保存のtransactionの中（先に並んだ操作がcommitされた後）で呼ぶ認可の確認。
  // HTMLからの回答案のように、受け付けた後に権限が失効しうる経路で使う。
  async updateDraft(
    requestId: string,
    rawParams: unknown,
    options: { authorize?: () => void } = {},
  ): Promise<ServiceResult<{ draftVersion: number }>> {
    const params = feedbackDraftParamsSchema.parse(rawParams);
    const record = await this.#store.transaction((tx) => {
      options.authorize?.();
      const current = this.#require(tx.state, requestId);
      if (current.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'この質問は、回答を受け付けていません。', {
          requestId,
          status: current.status,
        });
      }
      if (current.draftVersion !== params.expectedDraftVersion) {
        throw new VdeError('E_DRAFT_CONFLICT', '回答案が別の画面で更新されています。', {
          requestId,
          draftVersion: current.draftVersion,
        });
      }
      const issues = validateAnswers(current.questionnaire, params.answers, { complete: false });
      if (issues.length > 0) throw answerError(issues);
      current.draftAnswers = structuredClone(params.answers) as FeedbackRecord['draftAnswers'];
      current.draftVersion += 1;
      current.updatedAt = this.#now().toISOString();
      return structuredClone(current);
    });
    this.#changed(record);
    return this.#result({ draftVersion: record.draftVersion });
  }

  // 保存済みの回答案を、回答として確定する（仕様11.8）。回答そのものは受け取らない。
  // 同じsubmission IDと同じ条件の再送は、同じ結果を返す。条件が違えば競合にする。
  async submit(requestId: string, rawParams: unknown): Promise<ServiceResult<FeedbackForUi>> {
    const params = feedbackSubmitParamsSchema.parse(rawParams);
    const digest = sha256(
      canonicalJson({
        expectedDraftVersion: params.expectedDraftVersion,
        revision: params.revision,
        currentRevision: params.currentRevision,
        confirmOlderRevision: params.confirmOlderRevision,
      }),
    );
    const outcome = await this.#store.transaction((tx) => {
      const state = tx.state;
      const record = this.#require(state, requestId);
      if (
        record.status === 'submitted' &&
        record.submission?.submissionId === params.submissionId
      ) {
        if (record.submissionDigest !== digest) {
          throw new VdeError(
            'E_SUBMISSION_CONFLICT',
            '同じ送信IDで、条件の違う送信がありました。確定した回答は変えません。',
            { requestId },
          );
        }
        return { record: structuredClone(record), changed: false };
      }
      if (record.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'この質問は、回答を受け付けていません。', {
          requestId,
          status: record.status,
        });
      }
      if (record.draftVersion !== params.expectedDraftVersion) {
        throw new VdeError(
          'E_DRAFT_CONFLICT',
          '確認した後に回答案が変わりました。内容を確かめてから送信してください。',
          { requestId, draftVersion: record.draftVersion },
        );
      }
      if (record.revision !== params.revision) {
        throw new VdeError('E_SUBMISSION_CONFLICT', '質問の対象の版が一致しません。', {
          requestId,
          revision: record.revision,
        });
      }
      const current = state.documents[record.documentId]?.currentRevision ?? null;
      const newer = current !== record.revision;
      // 新しい版があるときは、旧版への回答であることを本体で確認した場合だけ送る（仕様11.4）。
      // 確認した後にさらに版が変われば、確認し直してもらう。
      if (params.currentRevision !== current || (newer && !params.confirmOlderRevision)) {
        throw new VdeError(
          'E_NEWER_REVISION',
          '新しい版があります。この回答は表示中の旧版に対するものです。確認してから送信してください。',
          { requestId, revision: record.revision, currentRevision: current },
        );
      }
      const issues = validateAnswers(record.questionnaire, record.draftAnswers, { complete: true });
      if (issues.length > 0) throw answerError(issues);
      const timestamp = this.#now().toISOString();
      record.status = 'submitted';
      record.submission = {
        submissionId: params.submissionId,
        answers: structuredClone(record.draftAnswers),
        submittedAt: timestamp,
        revision: record.revision,
        confirmedAgainstOlderRevision: newer,
        currentRevisionAtSubmit: current,
      };
      record.submissionDigest = digest;
      record.updatedAt = timestamp;
      return { record: structuredClone(record), changed: true };
    });
    if (outcome.changed) this.#changed(outcome.record);
    return this.#result(this.#toUi(this.#store.payload, outcome.record));
  }

  // 保持している項目の数（資源の漏れの確認に使う。daemon.diagnostics）。
  retainedCounts(): Record<string, number> {
    let waiters = 0;
    for (const set of this.#waiters.values()) waiters += set.size;
    return { waitedRequests: this.#waiters.size, waiters };
  }

  // 停止の前に呼ぶ。待っている処理を終わらせる（質問の状態は変えない）。
  close(): void {
    this.#closed = true;
    const error = new VdeError('E_DAEMON_STOPPING', 'daemonは停止処理中です。');
    // 終えた処理は、自分を集合から外す。走査中に外しても、残りの要素は順に処理される。
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.fail(error);
    }
  }
}
