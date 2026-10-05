import type {
  Answers,
  DocumentSummary,
  FeedbackForUi,
  FeedbackSubmitParams,
  HtmlMode,
  LinkOpenResult,
  ListResult,
  OutlineItem,
  ReadResult,
  RenderGrantResult,
  SearchResult,
  ServerEvent,
  SessionResult,
  UiStatus,
} from '@vde-open/shared';

import { createSseParser } from './sse.ts';

const API = '/_/api/v1';
const TOKEN_KEY = 'vde-open.session';
const READ_PAGE_BYTES = 1024 * 1024;
const RECONNECT_MAX_MS = 10_000;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface EnvelopeBody<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  meta?: { catalogVersion?: number };
}

async function parseEnvelope<T>(response: Response): Promise<EnvelopeBody<T>> {
  const body = (await response.json()) as EnvelopeBody<T>;
  if (!response.ok || !body.ok) {
    throw new ApiError(
      body.error?.code ?? 'E_INTERNAL',
      body.error?.message ?? 'The operation failed.',
      response.status,
      body.error?.details ?? {},
    );
  }
  return body;
}

// Take the ticket from the fragment of the URL the CLI opened and exchange it for a session token (spec 6.4).
// The fragment is removed from history right after reading (the query, which names the shown document, stays).
// The token lives only in this tab's memory and sessionStorage.
export async function establishSession(): Promise<string | null> {
  const match = /^#bootstrap=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (match) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    try {
      const response = await fetch(`${API}/sessions/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: match[1] }),
      });
      const { data } = await parseEnvelope<SessionResult>(response);
      window.sessionStorage.setItem(TOKEN_KEY, data.token);
      return data.token;
    } catch {
      // A used or expired URL. Use the saved session if there is one.
    }
  }
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function forgetSession(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

export interface EventStream {
  close(): void;
}

export interface Api {
  status(): Promise<UiStatus>;
  documents(): Promise<{ documents: DocumentSummary[]; catalogVersion: number }>;
  content(documentId: string, revision: string): Promise<string>;
  outline(documentId: string, revision: string): Promise<NonNullable<ReadResult['outline']>>;
  close(documentId: string): Promise<void>;
  reorder(order: string[], expectedCatalogVersion: number): Promise<void>;
  focus(documentId: string): Promise<void>;
  refresh(documentId: string): Promise<void>;
  // Fetch a render grant for one revision of a document.
  renderGrant(
    documentId: string,
    revision: string,
    options?: { mode?: HtmlMode },
  ): Promise<RenderGrantResult>;
  // Search open documents (spec chapter 9).
  search(query: string, limit: number): Promise<SearchResult>;
  // A view with the revision and view mode pinned by a pending question. The daemon decides the view mode from the question.
  feedbackRenderGrant(requestId: string): Promise<RenderGrantResult>;
  // Relay of operations from the HTML SDK. Succeeds only while the render grant is valid.
  bridgeReady(grant: string): Promise<FeedbackForUi>;
  bridgeDraft(
    grant: string,
    expectedDraftVersion: number,
    answers: Answers,
  ): Promise<{ draftVersion: number }>;
  // Unregistered files the view tried to load.
  renderMissing(grant: string): Promise<string[]>;
  // Change the HTML view mode. When switching to interactive, call this only after the user confirms.
  setHtmlMode(documentId: string, mode: HtmlMode): Promise<DocumentSummary>;
  // Release grants whose views were dismissed.
  releaseGrants(grants: string[]): Promise<void>;
  // Open the local document a link in the document points to. For an unregistered document, the error asks for confirmation.
  // Calling again with the confirmation identifier from that error opens it.
  openLink(
    documentId: string,
    revision: string,
    linkId: string,
    confirmation?: string,
  ): Promise<LinkOpenResult>;
  // The question (including the questionnaire, the draft answer, and the document's current revision).
  feedback(requestId: string): Promise<FeedbackForUi>;
  // Replace the draft answer. Pass the draft version it is based on.
  saveDraft(
    requestId: string,
    expectedDraftVersion: number,
    answers: Answers,
  ): Promise<{ draftVersion: number }>;
  // Finalize the saved draft answer as the answer.
  submitFeedback(requestId: string, params: FeedbackSubmitParams): Promise<FeedbackForUi>;
  // Cancel the question (call after the user confirms).
  cancelFeedback(requestId: string): Promise<void>;
  // Subscribe to update notifications. On disconnect, reconnect with growing delays, and call onConnect on every connection.
  events(handlers: { onEvent: (event: ServerEvent) => void; onConnect: () => void }): EventStream;
}

export function createApi(token: string, onUnauthorized: () => void): Api {
  const request = async <T>(path: string, init: RequestInit = {}): Promise<EnvelopeBody<T>> => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    if (response.status === 401) onUnauthorized();
    return parseEnvelope<T>(response);
  };

  return {
    async status() {
      return (await request<UiStatus>('/status')).data;
    },
    async documents() {
      const documents: DocumentSummary[] = [];
      let cursor: string | null = null;
      let catalogVersion = 0;
      do {
        const query: string =
          cursor === null ? '?limit=500' : `?limit=500&cursor=${encodeURIComponent(cursor)}`;
        const page: EnvelopeBody<ListResult> = await request<ListResult>(`/documents${query}`);
        documents.push(...page.data.documents);
        cursor = page.data.nextCursor;
        catalogVersion = page.meta?.catalogVersion ?? catalogVersion;
      } while (cursor !== null);
      return { documents, catalogVersion };
    },
    // Read the given revision. For large documents, fetch the rest with the cursor and join.
    async content(documentId, revision) {
      let text = '';
      let cursor: string | null = null;
      do {
        const query: string =
          cursor === null
            ? `?revision=${revision}&maxBytes=${String(READ_PAGE_BYTES)}`
            : `?maxBytes=${String(READ_PAGE_BYTES)}&cursor=${encodeURIComponent(cursor)}`;
        const page: EnvelopeBody<ReadResult> = await request<ReadResult>(
          `/documents/${documentId}/content${query}`,
        );
        text += page.data.content ?? '';
        cursor = page.data.nextCursor;
      } while (cursor !== null);
      return text;
    },
    async outline(documentId, revision) {
      // Documents with many headings come back in several pages. Fetch to the end.
      const items: OutlineItem[] = [];
      let cursor: string | null = null;
      do {
        const query: string =
          cursor === null
            ? `?revision=${revision}&maxBytes=${String(READ_PAGE_BYTES)}`
            : `?maxBytes=${String(READ_PAGE_BYTES)}&cursor=${encodeURIComponent(cursor)}`;
        const page: EnvelopeBody<ReadResult> = await request<ReadResult>(
          `/documents/${documentId}/outline${query}`,
        );
        items.push(...(page.data.outline ?? []));
        cursor = page.data.nextCursor;
      } while (cursor !== null);
      return items;
    },
    async close(documentId) {
      await request(`/documents/${documentId}`, { method: 'DELETE' });
    },
    async reorder(order, expectedCatalogVersion) {
      await request('/documents/order', {
        method: 'PUT',
        body: JSON.stringify({ order, expectedCatalogVersion }),
      });
    },
    async focus(documentId) {
      await request(`/documents/${documentId}/focus`, { method: 'POST' });
    },
    async refresh(documentId) {
      await request(`/documents/${documentId}/refresh`, { method: 'POST' });
    },
    async renderGrant(documentId, revision, options = {}) {
      const { data } = await request<RenderGrantResult>(`/documents/${documentId}/render-grants`, {
        method: 'POST',
        body: JSON.stringify({ revision, mode: options.mode ?? 'static' }),
      });
      return data;
    },
    async search(query, limit) {
      const params = new URLSearchParams({ query, limit: String(limit) });
      return (await request<SearchResult>(`/search?${params.toString()}`)).data;
    },
    async feedbackRenderGrant(requestId) {
      const { data } = await request<RenderGrantResult>(`/feedback/${requestId}/render-grants`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return data;
    },
    async bridgeReady(grant) {
      return (
        await request<FeedbackForUi>('/render-grants/bridge/ready', {
          method: 'POST',
          body: JSON.stringify({ grant }),
        })
      ).data;
    },
    async bridgeDraft(grant, expectedDraftVersion, answers) {
      return (
        await request<{ draftVersion: number }>('/render-grants/bridge/draft', {
          method: 'PUT',
          body: JSON.stringify({ grant, expectedDraftVersion, answers }),
        })
      ).data;
    },
    async renderMissing(grant) {
      const { data } = await request<{ missing: string[] }>('/render-grants/missing', {
        method: 'POST',
        body: JSON.stringify({ grant }),
      });
      return data.missing;
    },
    async setHtmlMode(documentId, mode) {
      const { data } = await request<DocumentSummary>(`/documents/${documentId}/html-mode`, {
        method: 'POST',
        body: JSON.stringify({ mode, confirmed: true }),
      });
      return data;
    },
    async releaseGrants(grants) {
      await request('/render-grants/release', { method: 'POST', body: JSON.stringify({ grants }) });
    },
    async openLink(documentId, revision, linkId, confirmation) {
      const { data } = await request<LinkOpenResult>(
        `/documents/${documentId}/links/${linkId}/open`,
        { method: 'POST', body: JSON.stringify({ revision, confirmation }) },
      );
      return data;
    },
    async feedback(requestId) {
      return (await request<FeedbackForUi>(`/feedback/${requestId}`)).data;
    },
    async saveDraft(requestId, expectedDraftVersion, answers) {
      return (
        await request<{ draftVersion: number }>(`/feedback/${requestId}/draft`, {
          method: 'PUT',
          body: JSON.stringify({ expectedDraftVersion, answers }),
        })
      ).data;
    },
    async submitFeedback(requestId, params) {
      return (
        await request<FeedbackForUi>(`/feedback/${requestId}/submit`, {
          method: 'POST',
          body: JSON.stringify(params),
        })
      ).data;
    },
    async cancelFeedback(requestId) {
      await request(`/feedback/${requestId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
    },
    events({ onEvent, onConnect }) {
      const controller = new AbortController();
      let attempt = 0;
      const run = async () => {
        while (!controller.signal.aborted) {
          try {
            // Read with plain fetch, which can carry headers. Do not put the token in the URL.
            const response = await fetch(`${API}/events`, {
              headers: { Authorization: `Bearer ${token}` },
              // Do not cache the notification stream (so the browser cache does not make a second connection to the same URL wait).
              cache: 'no-store',
              signal: controller.signal,
            });
            if (response.status === 401) {
              onUnauthorized();
              return;
            }
            if (!response.ok || !response.body) throw new Error('events unavailable');
            attempt = 0;
            onConnect();
            const parser = createSseParser((message) => {
              try {
                onEvent(JSON.parse(message.data) as ServerEvent);
              } catch {
                // Drop events that cannot be parsed. State is refetched on the next connection.
              }
            });
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parser.push(value);
            }
          } catch {
            if (controller.signal.aborted) return;
          }
          // After a disconnect, reconnect with growing delays (capped at 10 seconds, with jitter).
          attempt += 1;
          const delay = Math.min(RECONNECT_MAX_MS, 250 * 2 ** attempt) * (0.5 + Math.random() / 2);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      };
      void run();
      return { close: () => controller.abort() };
    },
  };
}
