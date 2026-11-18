import type {
  MobileContentResult,
  MobileDocument,
  MobileEvent,
  MobileGrantResult,
  MobileLinkResult,
  MobileListResult,
} from '@vde-open/shared';

import { ApiError } from './api.ts';
import { createSseParser } from './sse.ts';

// The phone reader's client (ADR-0017). It talks only to `/_/mobile/v1` on its own origin: no management calls.
const API = '/_/mobile/v1';
const RECONNECT_MAX_MS = 10_000;
// Two heartbeat periods (15 s) plus 5 s without receiving anything, including heartbeat comments.
export const SILENCE_LIMIT_MS = 35_000;

export interface MobileCatalog {
  daemonId: string;
  documents: MobileDocument[];
}

export interface MobileStream {
  close(): void;
}

export interface MobileApi {
  // Every open document, newest opened first. Pages of another start or catalog are dropped and fetched again.
  documents(): Promise<MobileCatalog>;
  // The whole Markdown source of the listed revision.
  content(document: Pick<MobileDocument, 'documentId' | 'revision' | 'viewEpoch'>): Promise<string>;
  grant(
    document: Pick<MobileDocument, 'documentId' | 'revision' | 'viewEpoch'>,
  ): Promise<MobileGrantResult>;
  check(grant: string): Promise<boolean>;
  release(grants: string[], keepalive?: boolean): Promise<void>;
  resolveLink(grant: string, linkId: string): Promise<MobileLinkResult>;
  events(handlers: {
    onEvent: (event: MobileEvent) => void;
    onConnect: () => void;
    // Called when the stream is lost (closed, failed, or silent for too long).
    onDisconnect: () => void;
  }): MobileStream;
}

async function envelopeOf<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as {
    ok: boolean;
    data: T;
    error?: { code: string; message: string };
  } | null;
  if (!response.ok || !body?.ok) {
    throw new ApiError(
      body?.error?.code ?? 'E_INTERNAL',
      body?.error?.message ?? 'The request failed.',
      response.status,
      {},
    );
  }
  return body.data;
}

// Newest opened first; equal times by documentId, descending. Saving or focusing on the PC does not move a row.
export function orderDocuments(documents: MobileDocument[]): MobileDocument[] {
  return documents.toSorted((a, b) =>
    a.openedAt === b.openedAt
      ? b.documentId.localeCompare(a.documentId)
      : b.openedAt.localeCompare(a.openedAt),
  );
}

export function createMobileApi(): MobileApi {
  const get = async <T>(path: string) =>
    envelopeOf<T>(await fetch(`${API}${path}`, { cache: 'no-store' }));
  const post = async <T>(path: string, body: unknown, keepalive = false) =>
    envelopeOf<T>(
      await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive,
      }),
    );

  return {
    async documents() {
      // A list that changes between pages is fetched again from the start (a few times at most).
      for (let attempt = 0; ; attempt += 1) {
        try {
          const first = await get<MobileListResult>('/documents');
          const documents = [...first.documents];
          let cursor = first.nextCursor;
          while (cursor !== null) {
            const page: MobileListResult = await get<MobileListResult>(
              `/documents?cursor=${encodeURIComponent(cursor)}`,
            );
            if (page.daemonId !== first.daemonId || page.catalogVersion !== first.catalogVersion) {
              throw new ApiError('E_CURSOR_STALE', 'The list changed.', 409, {});
            }
            documents.push(...page.documents);
            cursor = page.nextCursor;
          }
          return { daemonId: first.daemonId, documents: orderDocuments(documents) };
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409) || attempt >= 3) throw error;
        }
      }
    },
    async content(document) {
      let text = '';
      let page = await get<MobileContentResult>(
        `/documents/${document.documentId}/content?revision=${document.revision ?? ''}&viewEpoch=${document.viewEpoch}`,
      );
      text += page.content;
      while (page.nextCursor !== null) {
        page = await get<MobileContentResult>(
          `/documents/${document.documentId}/content?cursor=${encodeURIComponent(page.nextCursor)}`,
        );
        text += page.content;
      }
      return text;
    },
    grant(document) {
      return post<MobileGrantResult>(`/documents/${document.documentId}/render-grants`, {
        revision: document.revision,
        viewEpoch: document.viewEpoch,
      });
    },
    async check(grant) {
      return (await post<{ valid: boolean }>('/render-grants/check', { grant })).valid;
    },
    async release(grants, keepalive = false) {
      if (grants.length > 0) await post('/render-grants/release', { grants }, keepalive);
    },
    resolveLink(grant, linkId) {
      return post<MobileLinkResult>('/links/resolve', { grant, linkId });
    },
    events({ onEvent, onConnect, onDisconnect }) {
      const controller = new AbortController();
      let attempt = 0;
      const run = async () => {
        while (!controller.signal.aborted) {
          const connection = new AbortController();
          const abortConnection = () => connection.abort();
          controller.signal.addEventListener('abort', abortConnection);
          // Anything received (events or heartbeat comments) proves the stream is alive.
          let silence: ReturnType<typeof setTimeout> | undefined;
          const heard = () => {
            clearTimeout(silence);
            silence = setTimeout(abortConnection, SILENCE_LIMIT_MS);
          };
          try {
            const response = await fetch(`${API}/events`, {
              cache: 'no-store',
              signal: connection.signal,
            });
            if (!response.ok || !response.body) throw new Error('events unavailable');
            attempt = 0;
            heard();
            onConnect();
            const parser = createSseParser((message) => {
              try {
                onEvent(JSON.parse(message.data) as MobileEvent);
              } catch {
                // Unreadable events are dropped; the next connection resyncs.
              }
            });
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              heard();
              parser.push(value);
            }
          } catch {
            // Reconnect below.
          } finally {
            clearTimeout(silence);
            controller.signal.removeEventListener('abort', abortConnection);
          }
          if (controller.signal.aborted) return;
          onDisconnect();
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
