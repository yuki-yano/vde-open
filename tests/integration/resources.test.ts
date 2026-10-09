import { request as httpRequest, type IncomingMessage } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonControl } from '../../apps/cli/src/cli/daemon-control.ts';
import type { WorkerDiagnostics } from '../../apps/cli/src/diagnostics/heap.ts';
import type { IpcConnection } from '../../apps/cli/src/server/ipc-client.ts';
import { LIMITS } from '../../packages/shared/src/limits.ts';
import { createTestHome, type TestHome } from './harness.ts';
import { connectUi } from './ui-client.ts';

interface Diagnostics {
  watchers: { directories: number; created: number; closed: number };
  eventSubscribers: number;
  eventStreams: { streams: number; maxPending: number };
  retained: Record<string, Record<string, number>>;
  heapUsedBytes: number;
  workers: Record<'search' | 'parse', WorkerDiagnostics | null>;
  renderGrants: number;
  activeResources: Record<string, number>;
  rssBytes: number;
  cpuMicros: number;
}

let t: TestHome;
let ipc: IpcConnection | null;

beforeEach(() => {
  t = createTestHome();
  ipc = null;
});

afterEach(async () => {
  ipc?.close();
  await t.cleanup();
});

// Start the daemon and connect directly over IPC (to avoid starting hundreds of CLI processes).
async function connect(): Promise<(method: string, params?: unknown) => Promise<unknown>> {
  t.write('start.md', '# start\n');
  expect((await t.run(['open', 'start.md', '--json'])).exitCode).toBe(0);
  ipc = await createDaemonControl({
    env: { VDE_OPEN_HOME: t.home },
    platform: process.platform,
    homeDir: process.env['HOME'] ?? '',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  }).connectExisting();
  if (!ipc) throw new Error('cannot connect to the daemon');
  const connection = ipc;
  return async (method, params = {}) => {
    const envelope = await connection.request<unknown>(method, params);
    if (!envelope.ok) throw new Error(`${method}: ${JSON.stringify(envelope.error)}`);
    return envelope.data;
  };
}

const total = (resources: Record<string, number>) =>
  Object.values(resources).reduce((sum, count) => sum + count, 0);
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until removed watchers finish closing (closing is asynchronous).
async function watchersSettled(call: (method: string) => Promise<unknown>): Promise<Diagnostics> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const diagnostics = (await call('daemon.diagnostics')) as Diagnostics;
    const { directories, created, closed } = diagnostics.watchers;
    if (created - closed === directories || Date.now() > deadline) return diagnostics;
    await settle(100);
  }
}

// Connect to SSE and either hold without reading (a slow client) or close immediately.
function openEvents(origin: string): Promise<{ response: IncomingMessage; close: () => void }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/_/api/v1/events',
      },
      (response) => resolve({ response, close: () => request.destroy() }),
    );
    request.on('error', reject);
    request.end();
  });
}

describe('PERF-003 repeated open/close and watch', () => {
  it('resources such as watchers, sockets, and timers do not keep growing over 100 open/close cycles and repeated watch rule add/remove', async () => {
    const call = await connect();
    for (let index = 0; index < 5; index += 1)
      t.write(`docs/${String(index)}.md`, `# 文書${String(index)}\n`);
    const cycle = async (index: number) => {
      const path = `docs/${String(index % 5)}.md`;
      await call('documents.open', { cwd: t.work, paths: [path] });
      await call('documents.close', { cwd: t.work, targets: [path] });
    };
    // Count after the resources created right after startup (workers, listeners, etc.) are all in place.
    for (let index = 0; index < 10; index += 1) await cycle(index);
    await settle(500);
    const before = await watchersSettled(call);

    for (let index = 0; index < 100; index += 1) await cycle(index);
    for (let index = 0; index < 20; index += 1) {
      const opened = (await call('documents.open', {
        cwd: t.work,
        paths: ['docs'],
        watch: true,
      })) as { watchRules: Array<{ watchId: string }> };
      for (const rule of opened.watchRules) await call('watch.remove', { watchId: rule.watchId });
      await call('documents.close', {
        cwd: t.work,
        targets: Array.from({ length: 5 }, (_, file) => `docs/${String(file)}.md`),
      });
    }
    await settle(1000);
    const after = await watchersSettled(call);
    // All removed watchers have finished closing (created - closed = number of watched directories).
    // A leaked release may not show in the management list count or the total of Node resources, so check the balance of creation and release.
    expect(after.watchers.created).toBeGreaterThan(before.watchers.created);
    expect(after.watchers.created - after.watchers.closed).toBe(after.watchers.directories);
    expect(after.watchers.directories).toBeLessThanOrEqual(before.watchers.directories);
    expect(after.eventSubscribers).toBe(0);
    // Even after 120 operations, the resource count is about the same (if it grew per operation, it would grow by 100 or more).
    expect(total(after.activeResources)).toBeLessThanOrEqual(total(before.activeResources) + 5);
  });
});

describe('PERF-003 continuous memory growth', () => {
  it('the number of retained items and the post-GC heap do not keep growing over repeated open, read, search, render, and close', async () => {
    const call = await connect();
    const ui = await connectUi(t);
    // A document of about 40 KiB (20,000 UTF-16 characters).
    const body = '本文の行。'.repeat(4000);
    const cycle = async (index: number) => {
      // Change the content every time to create a new revision (parse results and revision records are replaced too).
      const path = `docs/${String(index % 5)}.md`;
      t.write(
        path,
        `# 文書${String(index % 5)}\n\n${body}\n\n## 節${String(index)}\n\n更新${String(index)}\n`,
      );
      const opened = (await call('documents.open', { cwd: t.work, paths: [path] })) as {
        documents: Array<{ documentId: string }>;
      };
      const documentId = opened.documents[0]?.documentId as string;
      await call('documents.read', { documentId });
      await call('documents.search', { query: '本文', limit: 5 }).catch(() => null);
      const grant = await ui.grant(documentId);
      await ui.api('/render-grants/release', { method: 'POST', body: { grants: [grant.grant] } });
      await call('documents.close', { cwd: t.work, targets: [path] });
    };
    // Diagnostics first bring the search index up to date with the current documents and clean up removed items,
    // then collect garbage in the daemon itself and each worker and measure the heap (no fixed wait).
    const measure = async () =>
      (await call('daemon.diagnostics', { collectGarbage: true })) as Diagnostics;
    for (let index = 0; index < 30; index += 1) await cycle(index);
    const samples: Diagnostics[] = [];
    for (let interval = 0; interval < 3; interval += 1) {
      for (let index = 0; index < 40; index += 1) await cycle(30 + interval * 40 + index);
      samples.push(await measure());
    }
    const [first, second, third] = samples as [Diagnostics, Diagnostics, Diagnostics];
    // The number of items the daemon itself retains (parse results, revision records, render grants and conversion results, index records, pending operations) does not change
    // between intervals. Records of closed documents stop at the number of documents ever opened (5 here).
    expect(second.retained).toEqual(first.retained);
    expect(third.retained).toEqual(first.retained);
    // The post-GC heap grows little per interval (measured on macOS, well under 1 MiB).
    // Leaking even one document-sized item (about 40 KiB) per cycle would add about 1.6 MiB per interval (40 cycles).
    const MiB = 1024 * 1024;
    expect(second.heapUsedBytes - first.heapUsedBytes).toBeLessThan(MiB);
    expect(third.heapUsedBytes - second.heapUsedBytes).toBeLessThan(MiB);
    // The search and parse workers are checked by the same criteria in their own threads (the index itself lives in the worker).
    // For the search worker, the number of items the index holds (committed and in-progress documents, index entries, terms) is compared too.
    for (const name of ['search', 'parse'] as const) {
      const [a, b, c] = [first, second, third].map((sample) => sample.workers[name]);
      if (!a || !b || !c) throw new Error(`no diagnostics for the ${name} worker`);
      expect(b.retained, name).toEqual(a.retained);
      expect(c.retained, name).toEqual(a.retained);
      expect(b.heapUsedBytes - a.heapUsedBytes, name).toBeLessThan(MiB);
      expect(c.heapUsedBytes - b.heapUsedBytes, name).toBeLessThan(MiB);
    }
  });
});

describe('PERF-004 slow client and consecutive updates', () => {
  it('consecutive updates and operations of other clients do not stall even with a client that does not read notifications', async () => {
    const call = await connect();
    const ui = await connectUi(t);
    const slow = await openEvents(ui.origin);
    slow.response.pause();
    try {
      const startedAt = Date.now();
      for (let index = 0; index < 50; index += 1) {
        await call('documents.open', {
          cwd: t.work,
          paths: [],
          stdin: { content: `# 更新${String(index)}\n\n${'本文'.repeat(2000)}\n` },
          format: 'markdown',
          key: 'busy',
        });
      }
      const listed = (await call('documents.list')) as { documents: Array<{ title: string }> };
      expect(listed.documents.some((document) => document.title === '更新49')).toBe(true);
      // Operations of another client (the CLI) also finish within the deadline.
      const fromCli = await t.run(['list', '--json']);
      expect(fromCli.exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      // The queue of a non-reading connection does not exceed the limit (plus one resync signal).
      // The check under a blocked write is in apps/cli/src/server/http/management.test.ts.
      const diagnostics = (await call('daemon.diagnostics')) as Diagnostics;
      expect(diagnostics.eventStreams.maxPending).toBeLessThanOrEqual(LIMITS.ssePendingEvents + 1);
    } finally {
      slow.close();
    }
    await settle(500);
    const closed = (await call('daemon.diagnostics')) as Diagnostics;
    expect(closed.eventStreams.streams).toBe(0);
    expect(closed.eventSubscribers).toBe(0);
  });
});

describe('PERF-005 idling and notification reconnects', () => {
  it('does not keep using CPU while idle, and no subscriptions remain after repeated notification connects and disconnects', async () => {
    const call = await connect();
    const ui = await connectUi(t);
    for (let index = 0; index < 30; index += 1) {
      const events = await openEvents(ui.origin);
      events.close();
    }
    await settle(500);
    expect(((await call('daemon.diagnostics')) as Diagnostics).eventSubscribers).toBe(0);

    const before = (await call('daemon.diagnostics')) as Diagnostics;
    await settle(3000);
    const after = (await call('daemon.diagnostics')) as Diagnostics;
    // CPU time used during 3 seconds of idling is under 5% of it (150 ms). A busy loop would make it nearly 3 seconds.
    expect(after.cpuMicros - before.cpuMicros).toBeLessThan(150_000);
  });
});
