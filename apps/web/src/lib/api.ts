import type {
  DocumentSummary,
  LinkOpenResult,
  ListResult,
  ReadResult,
  RenderGrantResult,
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
      body.error?.message ?? '操作に失敗しました。',
      response.status,
      body.error?.details ?? {},
    );
  }
  return body;
}

// CLIが開いたURLのfragmentからticketを取り出し、session tokenへ交換する（仕様6.4）。
// fragmentは読んだ直後に履歴から消す。tokenはこのtabのmemoryとsessionStorageにだけ置く。
export async function establishSession(): Promise<string | null> {
  const match = /^#bootstrap=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (match) {
    window.history.replaceState(null, '', window.location.pathname);
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
      // 使用済み・期限切れのURL。保存済みのsessionがあれば、それを使う。
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
  // 文書の1つの版を表示するための権限を取得する。
  renderGrant(documentId: string, revision: string): Promise<RenderGrantResult>;
  // 表示をやめた権限を返す。
  releaseGrants(grants: string[]): Promise<void>;
  // 文書中のlinkが指すlocalの文書を開く。未登録の文書は、確認を求めるerrorになる。
  // そのerrorが返す確認の識別子を付けて、もう一度呼ぶと開く。
  openLink(
    documentId: string,
    revision: string,
    linkId: string,
    confirmation?: string,
  ): Promise<LinkOpenResult>;
  // 更新通知を購読する。切断時は間隔を伸ばしながら再接続し、接続のたびにonConnectを呼ぶ。
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
    // 表示する版を指定して読む。大きい文書は、cursorで続きを取得してつなぐ。
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
      const { data } = await request<ReadResult>(
        `/documents/${documentId}/outline?revision=${revision}`,
      );
      return data.outline ?? [];
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
    async renderGrant(documentId, revision) {
      const { data } = await request<RenderGrantResult>(`/documents/${documentId}/render-grants`, {
        method: 'POST',
        body: JSON.stringify({ revision }),
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
    events({ onEvent, onConnect }) {
      const controller = new AbortController();
      let attempt = 0;
      const run = async () => {
        while (!controller.signal.aborted) {
          try {
            // headerを付けられる素のfetchで読む。tokenをURLへ載せない。
            const response = await fetch(`${API}/events`, {
              headers: { Authorization: `Bearer ${token}` },
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
                // 解釈できないeventは捨てる。次の接続時にstateを取り直す。
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
          // 切断後は、間隔を伸ばしながら再接続する（上限10秒、ゆらぎ付き）。
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
