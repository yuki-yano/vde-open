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

// daemonを起動し、IPCで直接つなぐ（CLIのprocessを何百回も起動しないため）。
async function connect(): Promise<(method: string, params?: unknown) => Promise<unknown>> {
  t.write('start.md', '# start\n');
  expect((await t.run(['open', 'start.md', '--json'])).exitCode).toBe(0);
  ipc = await createDaemonControl({
    env: { VDE_OPEN_HOME: t.home },
    platform: process.platform,
    homeDir: process.env['HOME'] ?? '',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  }).connectExisting();
  if (!ipc) throw new Error('daemonへ接続できません');
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

// 外したwatcherを閉じ終えるまで待つ（閉じる処理は非同期）。
async function watchersSettled(call: (method: string) => Promise<unknown>): Promise<Diagnostics> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const diagnostics = (await call('daemon.diagnostics')) as Diagnostics;
    const { directories, created, closed } = diagnostics.watchers;
    if (created - closed === directories || Date.now() > deadline) return diagnostics;
    await settle(100);
  }
}

// SSEへ接続し、読まずに保つ（遅いclient）か、すぐに切る。
function openEvents(
  origin: string,
  token: string,
): Promise<{ response: IncomingMessage; close: () => void }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: '/_/api/v1/events',
        headers: { Authorization: `Bearer ${token}` },
      },
      (response) => resolve({ response, close: () => request.destroy() }),
    );
    request.on('error', reject);
    request.end();
  });
}

describe('PERF-003 開閉と監視の反復', () => {
  it('100回の開閉と、監視ruleの追加・解除を繰り返しても、監視・socket・timerなどの資源が増え続けない', async () => {
    const call = await connect();
    for (let index = 0; index < 5; index += 1)
      t.write(`docs/${String(index)}.md`, `# 文書${String(index)}\n`);
    const cycle = async (index: number) => {
      const path = `docs/${String(index % 5)}.md`;
      await call('documents.open', { cwd: t.work, paths: [path] });
      await call('documents.close', { cwd: t.work, targets: [path] });
    };
    // 起動直後の資源（worker、listenerなど）が出そろってから数える。
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
    // 監視を外したwatcherは、すべて閉じ終えている（作った数－閉じた数＝監視中のdirectoryの数）。
    // 解放の漏れは、管理の一覧の件数やNodeの資源の総数には出ないことがあるため、作成と解放の収支で確かめる。
    expect(after.watchers.created).toBeGreaterThan(before.watchers.created);
    expect(after.watchers.created - after.watchers.closed).toBe(after.watchers.directories);
    expect(after.watchers.directories).toBeLessThanOrEqual(before.watchers.directories);
    expect(after.eventSubscribers).toBe(0);
    // 120回の操作の後でも、資源の数はほぼ同じ（操作ごとに増えていれば、100以上増える）。
    expect(total(after.activeResources)).toBeLessThanOrEqual(total(before.activeResources) + 5);
  });
});

describe('PERF-003 memoryの継続増加', () => {
  it('開く・読む・検索する・表示する・閉じるの反復で、保持する項目の数と回収後のheapが増え続けない', async () => {
    const call = await connect();
    const ui = await connectUi(t);
    // 約40KiBの文書（UTF-16で20,000文字）。
    const body = '本文の行。'.repeat(4000);
    const cycle = async (index: number) => {
      // 毎回内容を変え、新しい版を作る（解析の結果や版の記録も入れ替わる）。
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
    // 診断は、検索のindexを今の文書の状態に合わせ終え、消した項目を片付けてから、
    // daemonの本体と各workerで回収してheapを測る（決まった時間は待たない）。
    const measure = async () =>
      (await call('daemon.diagnostics', { collectGarbage: true })) as Diagnostics;
    for (let index = 0; index < 30; index += 1) await cycle(index);
    const samples: Diagnostics[] = [];
    for (let interval = 0; interval < 3; interval += 1) {
      for (let index = 0; index < 40; index += 1) await cycle(30 + interval * 40 + index);
      samples.push(await measure());
    }
    const [first, second, third] = samples as [Diagnostics, Diagnostics, Diagnostics];
    // daemonの本体が保持する項目（解析の結果、版の記録、表示の権限と変換の結果、索引の記録、待っている処理、
    // session）の数は、
    // 区間の間で変わらない。閉じた文書の記録は、開いたことのある文書の数（ここでは5）までで止まる。
    expect(second.retained).toEqual(first.retained);
    expect(third.retained).toEqual(first.retained);
    // 回収後のheapは、区間ごとの増え方が小さい（macOSの実測で、1MiBより十分小さい）。
    // 1回ごとに文書の大きさ（約40KiB）のものを1つでも残せば、1区間（40回）で約1.6MiB増える。
    const MiB = 1024 * 1024;
    expect(second.heapUsedBytes - first.heapUsedBytes).toBeLessThan(MiB);
    expect(third.heapUsedBytes - second.heapUsedBytes).toBeLessThan(MiB);
    // 検索と解析のworkerも、それぞれのthreadで同じ基準で確かめる（索引の実体はworkerの中にある）。
    // 検索のworkerは、indexが保持している項目（確定・途中の文書、索引の項目、語）の数も比べる。
    for (const name of ['search', 'parse'] as const) {
      const [a, b, c] = [first, second, third].map((sample) => sample.workers[name]);
      if (!a || !b || !c) throw new Error(`${name}のworkerの診断がありません`);
      expect(b.retained, name).toEqual(a.retained);
      expect(c.retained, name).toEqual(a.retained);
      expect(b.heapUsedBytes - a.heapUsedBytes, name).toBeLessThan(MiB);
      expect(c.heapUsedBytes - b.heapUsedBytes, name).toBeLessThan(MiB);
    }
  });
});

describe('PERF-004 遅いclientと連続した更新', () => {
  it('通知を読まないclientがいても、連続した更新と、ほかのclientの操作は止まらない', async () => {
    const call = await connect();
    const ui = await connectUi(t);
    const slow = await openEvents(ui.origin, ui.token);
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
      // 別のclient（CLI）の操作も、期限の内に終わる。
      const fromCli = await t.run(['list', '--json']);
      expect(fromCli.exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      // 読まない接続の待ち行列は、上限（と取り直しの合図1つ）を超えない。
      // 書き込みが詰まった状態での検証は、apps/cli/src/server/http/management.test.ts にある。
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

describe('PERF-005 待機と通知の再接続', () => {
  it('待機中にCPUを使い続けず、通知の接続と切断を繰り返しても購読が残らない', async () => {
    const call = await connect();
    const ui = await connectUi(t);
    for (let index = 0; index < 30; index += 1) {
      const events = await openEvents(ui.origin, ui.token);
      events.close();
    }
    await settle(500);
    expect(((await call('daemon.diagnostics')) as Diagnostics).eventSubscribers).toBe(0);

    const before = (await call('daemon.diagnostics')) as Diagnostics;
    await settle(3000);
    const after = (await call('daemon.diagnostics')) as Diagnostics;
    // 3秒の待機で使ったCPU時間が、その5%（150ms）未満。busy loopがあれば、ほぼ3秒になる。
    expect(after.cpuMicros - before.cpuMicros).toBeLessThan(150_000);
  });
});
