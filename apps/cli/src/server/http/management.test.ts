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
  // What was received over SSE, and whether the connection ended.
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
    pdf: {
      exportPdf: () => Promise.reject(new Error('Not used in this test.')),
      close: () => Promise.resolve(),
    },
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
  // With a storable response, Firefox holds a second connection to the same URL.
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
    if (Date.now() > deadline) throw new Error('Did not receive hello');
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
      setTimeout(() => reject(new Error('SSE does not end')), 5000),
    ),
  ]);

describe('SEC-001 connections of an expired session', () => {
  it('closes without sending a notification published after expiry, without waiting for the next periodic check', async () => {
    // The periodic check does not occur during this test.
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

  it('staying connected does not extend the expiry, and SSE is closed once it expires', async () => {
    const { store, events, stream, advance, token } = await connect(20);

    // Within the expiry, notifications arrive while the connection stays open. Repeated checks do not extend it.
    advance(LIMITS.sessionIdleMs - 1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.ended).toBe(false);
    events.publish({ type: 'catalog-changed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.received).toContain('event: catalog-changed');
    expect(events.subscriberCount).toBe(1);

    // Once expired, the next periodic check closes the connection and unsubscribes. It closes even without notifications.
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

// A connection that does not read notifications. Stops reading from the socket once hello is received.
// Keeps what was received (and keeps appending after reading resumes).
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

// Publish notifications until writes stall. The reading connection drains its queue, but the non-reading one keeps it.
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
    if (published > 400_000) throw new Error('Writes do not stall');
  }
}

// Extract the sequence numbers (`id:` lines) of received notifications, in arrival order.
const sequencesOf = (received: string) =>
  [...received.matchAll(/^id: (\d+)\r?$/gm)].map((match) => Number(match[1]));

describe('PERF-004 connections that do not read notifications', () => {
  it('the queue stops at the limit even when writes stall, the reading connection still receives, and the stalled one is cut', async () => {
    const { store, events, stream, token } = await connect(50, 3000);
    const running = server as ManagementServer;
    const stuck = await connectStuck(running.port, token);
    stuck.on('error', () => undefined);
    expect(running.eventStreams().streams).toBe(2);

    await fillUntilStuck(events, running);

    // Even after publishing 50,000 more once stalled, the queue never exceeds the limit (plus one resync marker).
    let maxPending = 0;
    for (let batch = 0; batch < 50; batch += 1) {
      for (let index = 0; index < 1000; index += 1) events.publish({ type: 'catalog-changed' });
      maxPending = Math.max(maxPending, running.eventStreams().maxPending);
      await tick();
    }
    expect(maxPending).toBeGreaterThan(0);
    expect(maxPending).toBeLessThanOrEqual(LIMITS.ssePendingEvents + 1);
    expect(running.eventStreams().streams).toBe(2);

    // The reading connection receives a resync marker in place of the dropped notifications, and the ones after it.
    await wait(200);
    const last = events.publish({ type: 'focus-requested' });
    const deadline = Date.now() + 5000;
    while (!stream.received.includes(`id: ${String(last.sequence)}\n`)) {
      if (Date.now() > deadline)
        throw new Error('Notification did not reach the reading connection');
      await wait(20);
    }
    expect(stream.received).toContain('event: resync-required');

    // A connection whose writes make no progress is cut after the deadline and unsubscribed. The reading one remains.
    const cutDeadline = Date.now() + 10_000;
    while (running.eventStreams().streams > 1) {
      if (Date.now() > cutDeadline) throw new Error('Stalled connection was not cut');
      await wait(50);
    }
    expect(events.subscriberCount).toBe(1);
    expect(stream.ended).toBe(false);
    stuck.resume();
    await Promise.race([once(stuck, 'close'), wait(5000)]);
    expect(stuck.destroyed).toBe(true);
    await store.close();
  });

  it('if the session expires while writes are stalled, closes down to the socket without sending the rest', async () => {
    // Verify that session expiry closes it before the stall cutoff (60 seconds) does.
    const { store, events, stream, token, advance } = await connect(50, 60_000);
    const running = server as ManagementServer;
    const stuck = await connectStuck(running.port, token);
    stuck.on('error', () => undefined);
    await fillUntilStuck(events, running);
    expect(running.eventStreams().streams).toBe(2);

    advance(LIMITS.sessionIdleMs + 1);
    const deadline = Date.now() + 5000;
    while (running.eventStreams().streams > 0) {
      if (Date.now() > deadline) throw new Error('Connection of the expired session did not end');
      await wait(20);
    }
    expect(events.subscriberCount).toBe(0);
    await ended(stream);
    // The server has closed the non-reading socket too (resuming reading delivers the end).
    stuck.resume();
    await Promise.race([once(stuck, 'close'), wait(5000)]);
    expect(stuck.destroyed).toBe(true);
    await store.close();
  });

  it('delivered sequences keep increasing and a resync marker arrives even as notifications continue after the queue overflows', async () => {
    const { store, events, token } = await connect(60_000);
    const running = server as ManagementServer;
    const slow = await connectStuck(running.port, token);
    slow.on('error', () => undefined);
    // Overflow the queue, then resume reading and keep publishing while writes progress.
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
      if (Date.now() > deadline) throw new Error('Last notification did not arrive');
      await wait(20);
    }
    expect(slow.received()).toContain('event: resync-required');
    const sequences = sequencesOf(slow.received());
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index], `index ${String(index)}`).toBeGreaterThan(
        sequences[index - 1] ?? -1,
      );
    }
    await store.close();
  });
});
