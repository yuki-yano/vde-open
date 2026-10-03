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
  // Called only after a commit succeeds. Carries only IDs and statuses.
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
  return new VdeError('E_REQUEST_NOT_FOUND', 'The question was not found.', { requestId });
}

function answerError(issues: AnswerIssue[]): VdeError {
  // Values are not included. Secrets written in answers never leak into errors or logs.
  return new VdeError('E_ANSWER_INVALID', 'The answers do not satisfy the question constraints.', {
    issues,
  });
}

// Parses the raw questionnaire. Rejects duplicate keys and `__proto__`, and accepts only the defined shape (spec 11.2).
export function parseQuestionnaire(text: string): Questionnaire {
  const bytes = utf8Length(text);
  if (bytes > LIMITS.questionnaireBytes) {
    throw new VdeError('E_LIMIT_EXCEEDED', 'The questionnaire is too large.', {
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
      throw new VdeError(
        'E_QUESTIONNAIRE_INVALID',
        'The questionnaire could not be parsed as JSON.',
        {
          reason: error.reason,
          pointer: error.pointer,
        },
      );
    }
    throw error;
  }
  const parsed = questionnaireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VdeError(
      'E_QUESTIONNAIRE_INVALID',
      'The questionnaire does not have an accepted shape.',
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}

// Questions and answers (spec 11). A question is pinned to the document revision at creation, and answers are finalized only by submit from the management UI.
// Agents receive only submitted answers (never draft answers).
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

  // Reports a question status change to the notification and to waiters.
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

  // Also called when the question status changes outside this service (when a document is closed).
  wake(requestId: string): void {
    for (const waiter of this.#waiters.get(requestId) ?? []) waiter.wake();
  }

  async create(rawParams: unknown): Promise<ServiceResult<FeedbackCreateResult>> {
    const params = feedbackCreateParamsSchema.parse(rawParams);
    const questionnaire = parseQuestionnaire(params.questionnaire);
    const questionnaireHash = sha256(canonicalJson(questionnaire));
    // Whether this is a replay of the same operation ID is decided by the question content and target.
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
          'A different question was already created with the same operation ID.',
          { requestId: existing.requestId },
        );
      }
      return existing;
    };
    const replayed = replay(this.#store.payload);
    if (replayed) return this.#result({ request: this.#toAgent(replayed), replayed: true });

    // --view opens the document, then pins the question to that revision.
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
        throw new VdeError('E_INVALID_ARGUMENT', '--view must specify exactly one document.', {
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
        // With only a question, create a document whose content is the question's title and instructions.
        const text = `# ${questionnaire.title}\n\n${questionnaire.instructions ?? ''}\n`;
        documentId = this.#documents.createGenerated(tx, { title: questionnaire.title, text });
        revision = null;
        generated = true;
      }
      const document = state.documents[documentId];
      if (!document) {
        throw new VdeError('E_DOCUMENT_NOT_FOUND', 'The document was not found.', { documentId });
      }
      if (!document.isOpen) {
        throw new VdeError('E_DOCUMENT_NOT_OPEN', 'The document is not open.', { documentId });
      }
      const pinned = revision ?? document.currentRevision;
      if (pinned === null || !document.revisions.some((entry) => entry.revision === pinned)) {
        throw new VdeError('E_REVISION_UNAVAILABLE', 'The specified revision is not retained.', {
          documentId,
          revision: pinned,
        });
      }
      // Only one pending question per document (spec 11.1).
      const pending = Object.values(state.feedbackRequests).find(
        (record) => record.documentId === documentId && record.status === 'pending',
      );
      if (pending) {
        throw new VdeError(
          'E_PENDING_REQUEST_EXISTS',
          'This document already has a pending question. Cancel it first to create a new one.',
          { documentId, requestId: pending.requestId },
        );
      }
      const requestId = `req_${randomUUID()}`;
      const record: FeedbackRecord = {
        requestId,
        documentId,
        revision: pinned,
        // The view mode is also pinned at creation (spec 11.4). Only interactive HTML with script permission
        // becomes a question whose draft answers can be sent from the HTML.
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

  // Fetch for agents. Read only; does not acknowledge (spec 11.3).
  get(rawParams: unknown): ServiceResult<FeedbackForAgent> {
    const { requestId } = feedbackIdParamsSchema.parse(rawParams);
    return this.#result(this.#toAgent(this.#require(this.#store.payload, requestId)));
  }

  // Waits until the answer is submitted or the question is cancelled. On timeout the question stays pending (spec 11.3).
  wait(rawParams: unknown): Promise<ServiceResult<FeedbackForAgent>> {
    const params = feedbackWaitParamsSchema.parse(rawParams);
    const settled = () => {
      const record = this.#require(this.#store.payload, params.requestId);
      return record.status === 'pending' ? null : record;
    };
    const done = settled();
    if (done) return Promise.resolve(this.#result(this.#toAgent(done)));
    if (this.#closed) {
      return Promise.reject(new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.'));
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
          new VdeError(
            'E_TIMEOUT',
            'Timed out waiting for the answer. The question is still pending.',
            {
              requestId: params.requestId,
              status: 'pending',
            },
          ),
        );
      }, params.timeoutMs);
      waiters.add(waiter);
    });
  }

  // Marks the answer as fetched and processed. Idempotent.
  async ack(rawParams: unknown): Promise<ServiceResult<FeedbackForAgent>> {
    const params = feedbackAckParamsSchema.parse(rawParams);
    const outcome = await this.#store.transaction((tx) => {
      const record = this.#require(tx.state, params.requestId);
      if (record.status !== 'submitted' || record.submission === null) {
        throw new VdeError('E_NOT_SUBMITTED', 'This question has no submitted answer.', {
          requestId: params.requestId,
          status: record.status,
        });
      }
      if (record.submission.submissionId !== params.submissionId) {
        throw new VdeError('E_SUBMISSION_CONFLICT', 'The submission ID does not match.', {
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

  // Cancels a pending question. If already cancelled, returns as is. A submitted question cannot be cancelled.
  async cancel(
    rawParams: unknown,
    actor: 'agent' | 'user',
  ): Promise<ServiceResult<FeedbackForAgent>> {
    const { requestId } = feedbackIdParamsSchema.parse(rawParams);
    const outcome = await this.#store.transaction((tx) => {
      const record = this.#require(tx.state, requestId);
      if (record.status === 'cancelled') return { record: structuredClone(record), changed: false };
      if (record.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'This question has already been answered.', {
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

  // Deletes the record of a finished question. Pending questions cannot be deleted. Originals, documents, and other questions are not touched (spec 7.3).
  async forget(rawParams: unknown): Promise<ServiceResult<{ requestId: string; forgotten: true }>> {
    const params = feedbackForgetParamsSchema.parse(rawParams);
    if (!params.confirmed) {
      throw new VdeError('E_CONFIRMATION_REQUIRED', 'Specify --yes to delete.', {
        requestId: params.requestId,
      });
    }
    await this.#store.transaction((tx) => {
      const state = tx.state;
      const record = this.#require(state, params.requestId);
      if (record.status === 'pending') {
        throw new VdeError(
          'E_REQUEST_PENDING',
          'A pending question cannot be deleted. Cancel it first.',
          {
            requestId: params.requestId,
          },
        );
      }
      delete state.feedbackRequests[params.requestId];
      // Revisions pinned only by this question can now be pruned by the normal rules.
      const document = state.documents[record.documentId];
      if (document) {
        document.revisions = pruneRevisions(
          document.revisions,
          this.#now().getTime(),
          pinnedRevisions(state, record.documentId),
        );
      }
    });
    // Removes stored content that is no longer referenced. Even if this fails, the record deletion is committed.
    await this.#store.collectGarbage().catch(() => 0);
    return this.#result({ requestId: params.requestId, forgotten: true });
  }

  // Fetch for the management UI. Includes the questionnaire and draft answers.
  getForUi(requestId: string): ServiceResult<FeedbackForUi> {
    const state = this.#store.payload;
    return this.#result(this.#toUi(state, this.#require(state, requestId)));
  }

  // Replaces the draft answers. If the base version differs, returns a conflict instead of overwriting (spec 11.6).
  // authorize is an authorization check called inside the store transaction (after queued operations are committed).
  // Used for paths where the grant may expire after acceptance, such as draft answers from the HTML.
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
        throw new VdeError('E_REQUEST_NOT_PENDING', 'This question is not accepting answers.', {
          requestId,
          status: current.status,
        });
      }
      if (current.draftVersion !== params.expectedDraftVersion) {
        throw new VdeError(
          'E_DRAFT_CONFLICT',
          'The draft answers were updated in another window.',
          {
            requestId,
            draftVersion: current.draftVersion,
          },
        );
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

  // Submits the saved draft answers as the answer (spec 11.8). The answers themselves are not accepted here.
  // A replay with the same submission ID and conditions returns the same result. Different conditions are a conflict.
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
            'A submission with the same submission ID but different conditions was received. The submitted answer is unchanged.',
            { requestId },
          );
        }
        return { record: structuredClone(record), changed: false };
      }
      if (record.status !== 'pending') {
        throw new VdeError('E_REQUEST_NOT_PENDING', 'This question is not accepting answers.', {
          requestId,
          status: record.status,
        });
      }
      if (record.draftVersion !== params.expectedDraftVersion) {
        throw new VdeError(
          'E_DRAFT_CONFLICT',
          'The draft answers changed after confirmation. Review them before submitting.',
          { requestId, draftVersion: record.draftVersion },
        );
      }
      if (record.revision !== params.revision) {
        throw new VdeError('E_SUBMISSION_CONFLICT', 'The question revision does not match.', {
          requestId,
          revision: record.revision,
        });
      }
      const current = state.documents[record.documentId]?.currentRevision ?? null;
      const newer = current !== record.revision;
      // When a newer revision exists, submit only if the host confirmed the answer is for the older revision (spec 11.4).
      // If the revision changes again after confirmation, confirmation is required again.
      if (params.currentRevision !== current || (newer && !params.confirmOlderRevision)) {
        throw new VdeError(
          'E_NEWER_REVISION',
          'A newer revision exists. This answer is for the older revision being displayed. Confirm before submitting.',
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

  // Counts of retained entries (used to check for resource leaks; daemon.diagnostics).
  retainedCounts(): Record<string, number> {
    let waiters = 0;
    for (const set of this.#waiters.values()) waiters += set.size;
    return { waitedRequests: this.#waiters.size, waiters };
  }

  // Called before shutdown. Ends waiting operations (question statuses are unchanged).
  close(): void {
    this.#closed = true;
    const error = new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.');
    // A finished waiter removes itself from the set. Removal during iteration still visits the remaining elements.
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.fail(error);
    }
  }
}
