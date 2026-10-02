import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIMITS } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../../documents/cursor.ts';
import { DocumentService } from '../../documents/service.ts';
import { StateStore } from '../../persistence/state-store.ts';
import { nodeStoreFs } from '../../persistence/store-fs.ts';
import { createRenderService } from '../../render/render-service.ts';
import { createParseService } from '../../workers/parse-service.ts';
import { createEventHub } from '../event-hub.ts';
import { createSessionService } from '../session-service.ts';
import { startManagementServer, type ManagementServer } from './management.ts';

let base: string;
let server: ManagementServer | null;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'vde-open-management-'));
  server = null;
});

afterEach(async () => {
  await server?.close();
  rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  store: StateStore;
  sessions: ReturnType<typeof createSessionService>;
  events: ReturnType<typeof createEventHub>;
  token: string;
  advance: (ms: number) => void;
  // SSEで受け取った内容と、接続が終わったか。
  stream: { received: string; ended: boolean; reading: Promise<void> };
}

async function connect(heartbeatMs: number): Promise<Fixture> {
  let now = 1_000_000;
  const store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  const documents = new DocumentService({ store, cursors: createCursorCodec(randomBytes(32)) });
  const sessions = createSessionService(() => now);
  const events = createEventHub('daemon_test', () => store.payload.catalogVersion);
  server = await startManagementServer({
    daemonId: 'daemon_test',
    version: '0.0.0',
    documents,
    sessions,
    events,
    render: createRenderService({
      store,
      documents,
      sessions,
      parse: createParseService(),
      previewOrigin: () => 'http://127.0.0.1:1',
    }),
    previewOrigin: 'http://127.0.0.1:1',
    webRoot: null,
    devOrigin: null,
    isStopping: () => false,
    heartbeatMs,
  });
  const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
  const response = await fetch(`${server.origin}/_/api/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const stream = { received: '', ended: false, reading: Promise.resolve() };
  stream.reading = (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
      if (chunk.done) break;
      stream.received += decoder.decode(chunk.value, { stream: true });
    }
    stream.ended = true;
  })();
  const deadline = Date.now() + 5000;
  while (!stream.received.includes('event: hello')) {
    if (Date.now() > deadline) throw new Error('helloを受け取れませんでした');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    store,
    sessions,
    events,
    token,
    advance: (ms) => {
      now += ms;
    },
    stream,
  };
}

const ended = (stream: Fixture['stream']) =>
  Promise.race([
    stream.reading,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('SSEが終了しません')), 5000),
    ),
  ]);

describe('SEC-001 期限が切れたsessionの接続', () => {
  it('期限が切れた後の通知は、次の定期確認を待たずに、送らずに閉じる', async () => {
    // 定期確認は、この試験の間には来ない。
    const { store, events, stream, advance, token } = await connect(60_000);
    advance(LIMITS.sessionIdleMs + 1);
    events.publish({ type: 'catalog-changed' });
    await ended(stream);
    expect(stream.received).not.toContain('catalog-changed');
    expect(events.subscriberCount).toBe(0);
    const after = await fetch(`${(server as ManagementServer).origin}/_/api/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    await store.close();
  });

  it('接続したままでも期限は延びず、期限が切れたらSSEを閉じる', async () => {
    const { store, events, stream, advance, token } = await connect(20);

    // 期限内は、接続を保ったまま通知を受け取れる。確認を何度繰り返しても期限は延びない。
    advance(LIMITS.sessionIdleMs - 1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.ended).toBe(false);
    events.publish({ type: 'catalog-changed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.received).toContain('event: catalog-changed');
    expect(events.subscriberCount).toBe(1);

    // 期限を過ぎると、次の定期確認で接続が閉じ、購読も外れる。通知がなくても閉じる。
    advance(1001);
    await ended(stream);
    expect(stream.ended).toBe(true);
    expect(events.subscriberCount).toBe(0);
    const after = await fetch(`${(server as ManagementServer).origin}/_/api/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
    await store.close();
  });
});
