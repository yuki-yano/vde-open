import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as connectSocket, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIMITS } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorCodec } from '../../documents/cursor.ts';
import { DocumentService } from '../../documents/service.ts';
import { FeedbackService } from '../../feedback/service.ts';
import { StateStore } from '../../persistence/state-store.ts';
import { nodeStoreFs } from '../../persistence/store-fs.ts';
import { createRenderService } from '../../render/render-service.ts';
import { createSearchService } from '../../search/search-service.ts';
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

async function connect(heartbeatMs: number, stallMs?: number): Promise<Fixture> {
  let now = 1_000_000;
  const store = await StateStore.open({ root: join(base, 'home'), fs: nodeStoreFs });
  const cursors = createCursorCodec(randomBytes(32));
  const documents = new DocumentService({ store, cursors });
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
    search: createSearchService({ store, cursors }),
    feedback: new FeedbackService({ store, documents }),
    previewOrigin: 'http://127.0.0.1:1',
    webRoot: null,
    devOrigin: null,
    isStopping: () => false,
    heartbeatMs,
    ...(stallMs === undefined ? {} : { stallMs }),
  });
  const token = sessions.exchange(sessions.createBootstrapTicket()) as string;
  const response = await fetch(`${server.origin}/_/api/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  // 保存を許す応答だと、Firefoxは同じURLへの2つ目の接続を待たせる。
  expect(response.headers.get('cache-control')).toBe('no-store');
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

// 通知を読まない接続。helloを受け取ったら、socketからの読み込みを止める。
// 受け取った内容は残す（読み込みを再開した後の内容も足していく）。
async function connectStuck(
  port: number,
  token: string,
): Promise<Socket & { received: () => string }> {
  const socket = connectSocket(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `GET /_/api/v1/events HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
  );
  let received = '';
  let paused = false;
  await new Promise<void>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      if (!paused && received.includes('event: hello')) {
        paused = true;
        socket.pause();
        resolve();
      }
    });
  });
  return Object.assign(socket, { received: () => received });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 書き込みが詰まるまで通知を出す。読む接続は待ち行列が空になるが、読まない接続は残る。
async function fillUntilStuck(events: Fixture['events'], running: ManagementServer): Promise<void> {
  let published = 0;
  for (;;) {
    for (let index = 0; index < 100; index += 1) events.publish({ type: 'catalog-changed' });
    published += 100;
    await wait(5);
    if (running.eventStreams().maxPending > 0) {
      await wait(200);
      if (running.eventStreams().maxPending > 0) return;
    }
    if (published > 400_000) throw new Error('書き込みが詰まりません');
  }
}

// 受け取った通知の連番（`id:`の行）を、届いた順に取り出す。
const sequencesOf = (received: string) =>
  [...received.matchAll(/^id: (\d+)\r?$/gm)].map((match) => Number(match[1]));

describe('PERF-004 通知を読まない接続', () => {
  it('書き込みが詰まっても待ち行列は上限で止まり、読む接続には届き、詰まった接続は切る', async () => {
    const { store, events, stream, token } = await connect(50, 3000);
    const running = server as ManagementServer;
    const stuck = await connectStuck(running.port, token);
    stuck.on('error', () => undefined);
    expect(running.eventStreams().streams).toBe(2);

    await fillUntilStuck(events, running);

    // 詰まった後に5万件を出しても、待ち行列は上限（と取り直しの合図1つ）を超えない。
    let maxPending = 0;
    for (let batch = 0; batch < 50; batch += 1) {
      for (let index = 0; index < 1000; index += 1) events.publish({ type: 'catalog-changed' });
      maxPending = Math.max(maxPending, running.eventStreams().maxPending);
      await tick();
    }
    expect(maxPending).toBeGreaterThan(0);
    expect(maxPending).toBeLessThanOrEqual(LIMITS.ssePendingEvents + 1);
    expect(running.eventStreams().streams).toBe(2);

    // 読む接続には、捨てた通知の代わりに取り直しの合図と、その後の通知が届く。
    await wait(200);
    const last = events.publish({ type: 'focus-requested' });
    const deadline = Date.now() + 5000;
    while (!stream.received.includes(`id: ${String(last.sequence)}\n`)) {
      if (Date.now() > deadline) throw new Error('読む接続へ通知が届きません');
      await wait(20);
    }
    expect(stream.received).toContain('event: resync-required');

    // 書き込みが進まない接続は、期限の後に切り、購読も外す。読む接続は残る。
    const cutDeadline = Date.now() + 10_000;
    while (running.eventStreams().streams > 1) {
      if (Date.now() > cutDeadline) throw new Error('詰まった接続が切れません');
      await wait(50);
    }
    expect(events.subscriberCount).toBe(1);
    expect(stream.ended).toBe(false);
    stuck.resume();
    await Promise.race([once(stuck, 'close'), wait(5000)]);
    expect(stuck.destroyed).toBe(true);
    await store.close();
  });

  it('書き込みが詰まったままsessionが失効したら、残りを送らずにsocketまで閉じる', async () => {
    // 詰まりによる切断（60秒）より先に、sessionの失効で閉じることを確かめる。
    const { store, events, stream, token, advance } = await connect(50, 60_000);
    const running = server as ManagementServer;
    const stuck = await connectStuck(running.port, token);
    stuck.on('error', () => undefined);
    await fillUntilStuck(events, running);
    expect(running.eventStreams().streams).toBe(2);

    advance(LIMITS.sessionIdleMs + 1);
    const deadline = Date.now() + 5000;
    while (running.eventStreams().streams > 0) {
      if (Date.now() > deadline) throw new Error('失効したsessionの接続が終わりません');
      await wait(20);
    }
    expect(events.subscriberCount).toBe(0);
    await ended(stream);
    // 読まない側のsocketも、serverが閉じている（読み込みを再開すると、終わりが届く）。
    stuck.resume();
    await Promise.race([once(stuck, 'close'), wait(5000)]);
    expect(stuck.destroyed).toBe(true);
    await store.close();
  });

  it('待ち行列があふれた後に通知が続いても、届く連番は増え続け、取り直しの合図が届く', async () => {
    const { store, events, token } = await connect(60_000);
    const running = server as ManagementServer;
    const slow = await connectStuck(running.port, token);
    slow.on('error', () => undefined);
    // 待ち行列をあふれさせてから読み込みを再開し、書き込みが進む間にも通知を出し続ける。
    await fillUntilStuck(events, running);
    for (let index = 0; index < 1000; index += 1) events.publish({ type: 'catalog-changed' });
    expect(running.eventStreams().maxPending).toBe(LIMITS.ssePendingEvents + 1);
    slow.resume();
    for (let index = 0; index < 2000; index += 1) {
      events.publish({ type: 'document-status' });
      if (index % 10 === 0) await tick();
    }
    const last = events.publish({ type: 'focus-requested' });
    const deadline = Date.now() + 10_000;
    while (!sequencesOf(slow.received()).includes(last.sequence)) {
      if (Date.now() > deadline) throw new Error('最後の通知が届きません');
      await wait(20);
    }
    expect(slow.received()).toContain('event: resync-required');
    const sequences = sequencesOf(slow.received());
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index], `${String(index)}番目`).toBeGreaterThan(sequences[index - 1] ?? -1);
    }
    await store.close();
  });
});
