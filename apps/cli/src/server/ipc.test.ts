import { randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IPC_PROTOCOL_VERSION, LIMITS, VdeError } from '@vde-open/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeProof, createNonce } from './ipc-auth.ts';
import { connectIpc } from './ipc-client.ts';
import { encodeFrame, FrameDecoder } from './ipc-frames.ts';
import { startIpcServer, type IpcServer } from './ipc-server.ts';

const DAEMON_ID = 'daemon_11111111-1111-4111-8111-111111111111';

let dir: string;
let socketPath: string;
let key: Buffer;
let server: IpcServer | null;
let calls: Array<{ method: string; params: unknown }>;
let hung: Array<() => void> = [];
let releaseSlow: () => void = () => undefined;

async function startServer(): Promise<void> {
  server = await startIpcServer({
    socketPath,
    key,
    daemonId: DAEMON_ID,
    handle: async (method, params) => {
      calls.push({ method, params });
      if (method === 'fail') throw new VdeError('E_DOCUMENT_NOT_FOUND', '見つかりません。');
      if (method === 'crash') throw new Error('内部の詳細');
      // 応答しないhandler。testの後始末で解放する。
      if (method === 'hang') await new Promise<void>((resolve) => hung.push(resolve));
      if (method === 'slow') {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return { data: { echo: params }, catalogVersion: 3 };
    },
  });
}

// 任意のbytesを送り、相手が閉じるまでに受け取った内容を返す。
function rawExchange(payloads: Buffer[]): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ received, closed: false });
    }, 2000);
    socket.on('connect', () => {
      for (const payload of payloads) socket.write(payload);
    });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ received, closed: true });
    });
  });
}

async function expectServerAlive(): Promise<void> {
  const connection = await connectIpc({ socketPath, key });
  try {
    const envelope = await connection.request('ping', { n: 1 });
    expect(envelope).toMatchObject({ ok: true, data: { echo: { n: 1 } } });
  } finally {
    connection.close();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vde-open-ipc-'));
  socketPath = join(dir, 'ipc.sock');
  key = randomBytes(32);
  calls = [];
  server = null;
  await startServer();
});

afterEach(async () => {
  for (const release of hung.splice(0)) release();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('IPCの正常系', () => {
  it('認証後にrequestを送り、CLIと同じenvelopeで応答を受け取る', async () => {
    const connection = await connectIpc({ socketPath, key });
    try {
      expect(connection.daemonId).toBe(DAEMON_ID);
      const [first, second] = await Promise.all([
        connection.request('documents.list', { limit: 5 }),
        connection.request('fail', {}),
      ]);
      expect(first).toEqual({
        schemaVersion: 1,
        ok: true,
        data: { echo: { limit: 5 } },
        warnings: [],
        meta: { command: 'documents.list', catalogVersion: 3 },
      });
      expect(second).toMatchObject({
        ok: false,
        error: { code: 'E_DOCUMENT_NOT_FOUND', retryable: false },
      });
    } finally {
      connection.close();
    }
  });

  it('想定外の例外の内容を相手へ返さない', async () => {
    const connection = await connectIpc({ socketPath, key });
    try {
      const envelope = await connection.request('crash', {});
      expect(envelope).toMatchObject({ ok: false, error: { code: 'E_INTERNAL' } });
      expect(JSON.stringify(envelope)).not.toContain('内部の詳細');
    } finally {
      connection.close();
    }
  });

  it.skipIf(process.platform === 'win32')('socketは所有者だけが使える権限になる', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});

describe('requestの期限と後始末', () => {
  it('応答がなければ期限でrejectし、接続は使い続けられる', async () => {
    const connection = await connectIpc({ socketPath, key });
    try {
      await expect(connection.request('hang', {}, { timeoutMs: 100 })).rejects.toMatchObject({
        code: 'E_DAEMON_UNAVAILABLE',
      });
      expect(await connection.request('ping', {})).toMatchObject({ ok: true });
    } finally {
      connection.close();
    }
  });

  it('明示的に閉じたら、応答待ちのrequestをrejectする', async () => {
    const connection = await connectIpc({ socketPath, key });
    const waiting = connection.request('hang', {});
    connection.close();
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' });
    await expect(connection.request('ping', {})).rejects.toMatchObject({
      code: 'E_DAEMON_UNAVAILABLE',
    });
  });

  it('serverが接続を切ったら、応答待ちのrequestをrejectする', async () => {
    const connection = await connectIpc({ socketPath, key });
    const waiting = connection.request('hang', {});
    await server?.close();
    server = null;
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' });
  });

  it('drainは実行中のrequestが応答を返し終えるまで待つ', async () => {
    const connection = await connectIpc({ socketPath, key });
    try {
      const slow = connection.request<{ echo: unknown }>('slow', { n: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      let drained = false;
      const draining = server?.drain().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drained).toBe(false);
      releaseSlow();
      await draining;
      expect(await slow).toMatchObject({ ok: true });
    } finally {
      connection.close();
    }
  });
});

describe('接続の中断', () => {
  const abortListeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;

  it('同じsignalで接続に何度失敗しても、失敗した接続のlistenerを残さない', async () => {
    const controller = new AbortController();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        connectIpc({ socketPath: join(dir, 'missing.sock'), key, signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' });
    }
    expect(abortListeners(controller.signal)).toBe(0);
    // 接続を確認し終えた後も残さない。
    const connection = await connectIpc({ socketPath, key, signal: controller.signal });
    connection.close();
    expect(abortListeners(controller.signal)).toBe(0);
  });

  it('中断済みのsignalでは、接続せずに失敗し、listenerも残さない', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(connectIpc({ socketPath, key, signal: controller.signal })).rejects.toMatchObject({
      code: 'E_DAEMON_UNAVAILABLE',
    });
    expect(abortListeners(controller.signal)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('応答しない相手に対するclientの終了', () => {
  it('期限の後に接続を閉じれば、相手が切断に応じなくてもprocessが終了する', async () => {
    // 認証までは正しく応じ、その後は何も返さず、相手からの切断にも応じないserver。
    await server?.close();
    server = null;
    rmSync(socketPath, { force: true });
    const accepted = new Set<Socket>();
    const unresponsive = createServer({ allowHalfOpen: true }, (socket) => {
      accepted.add(socket);
      const decoder = new FrameDecoder(() => LIMITS.ipcFrameBytes);
      let clientNonce = '';
      let serverNonce = '';
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame['type'] === 'hello') {
            clientNonce = frame['clientNonce'] as string;
            serverNonce = createNonce();
            socket.write(
              encodeFrame({
                type: 'hello',
                protocolVersion: IPC_PROTOCOL_VERSION,
                daemonId: DAEMON_ID,
                serverNonce,
                proof: computeProof(key, 'server', DAEMON_ID, clientNonce, serverNonce),
              }),
            );
          } else if (frame['type'] === 'auth') {
            socket.write(encodeFrame({ type: 'auth-ok' }));
          }
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => unresponsive.listen(socketPath, resolve));

    const clientModule = new URL('./ipc-client.ts', import.meta.url).href;
    const script = `
      import { connectIpc } from ${JSON.stringify(clientModule)};
      const connection = await connectIpc({
        socketPath: ${JSON.stringify(socketPath)},
        key: Buffer.from(${JSON.stringify(key.toString('hex'))}, 'hex'),
      });
      try {
        await connection.request('anything', {}, { timeoutMs: 50 });
        console.log('unexpected-response');
      } catch (error) {
        console.log(error.code);
      } finally {
        connection.close();
      }
    `;
    try {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      const exitCode = await new Promise<number | 'timeout'>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve('timeout');
        }, 5000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });
      expect(stdout.trim()).toBe('E_DAEMON_UNAVAILABLE');
      expect(exitCode).toBe(0);
    } finally {
      // 切断に応じないserverなので、受け付けた接続をこちらで破棄してから閉じる。
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => unresponsive.close(() => resolve()));
    }
  });
});

describe('SYS-004 認証前のIPC', () => {
  it('認証前の通常methodを拒否して切断し、handlerを呼ばない', async () => {
    const result = await rawExchange([
      encodeFrame({ id: 'x', method: 'documents.list', params: {} }),
    ]);
    expect(result.closed).toBe(true);
    expect(result.received).toContain('E_UNAUTHORIZED');
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('認証前の4KiBを超えるframeで切断する', async () => {
    const huge = Buffer.alloc(LIMITS.ipcPreAuthFrameBytes + 1, 0x61);
    const result = await rawExchange([huge]);
    expect(result.closed).toBe(true);
    expect(result.received).toBe('');
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('不正なJSONで切断する', async () => {
    const result = await rawExchange([Buffer.from('{"type":"hello",\n', 'utf8')]);
    expect(result.closed).toBe(true);
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('誤ったproofでは認証されず、その後のmethodも処理されない', async () => {
    const clientNonce = createNonce();
    const result = await rawExchange([
      encodeFrame({ type: 'hello', protocolVersion: IPC_PROTOCOL_VERSION, clientNonce }),
      encodeFrame({ type: 'auth', proof: 'ab'.repeat(32) }),
      encodeFrame({ id: 'x', method: 'documents.list', params: {} }),
    ]);
    expect(result.closed).toBe(true);
    expect(result.received).toContain('E_UNAUTHORIZED');
    expect(result.received).not.toContain('auth-ok');
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('別のprotocolVersionのclientを明示errorで拒否する', async () => {
    const result = await rawExchange([
      encodeFrame({ type: 'hello', protocolVersion: 2, clientNonce: createNonce() }),
    ]);
    expect(result.closed).toBe(true);
    expect(result.received).toContain('E_PROTOCOL_MISMATCH');
    await expectServerAlive();
  });
});

describe('SYS-005 接続相手の確認', () => {
  let fake: Server | null = null;
  let fakeReceived: Buffer[];

  // 本物のdaemonを止め、同じsocketで偽のserverを待ち受けさせる。
  async function startFakeServer(
    reply: (hello: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await server?.close();
    server = null;
    rmSync(socketPath, { force: true });
    fakeReceived = [];
    fake = createServer((socket) => {
      const decoder = new FrameDecoder(() => LIMITS.ipcFrameBytes);
      let replied = false;
      socket.on('data', (chunk: Buffer) => {
        fakeReceived.push(chunk);
        for (const frame of decoder.push(chunk)) {
          if (replied) continue;
          replied = true;
          socket.write(encodeFrame(reply(frame)));
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => fake?.listen(socketPath, resolve));
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
    fake = null;
  });

  function expectNoSecretLeak(): void {
    const wire = Buffer.concat(fakeReceived);
    expect(wire.includes(key)).toBe(false);
    expect(wire.toString('utf8')).not.toContain(key.toString('hex'));
    expect(wire.toString('utf8')).not.toContain(key.toString('base64'));
    // 相手を確認できていないので、clientのproofも送らない。
    expect(wire.toString('utf8')).not.toContain('"auth"');
  }

  it('keyを持たない偽serverのproofを信用せず、keyもproofも送らない', async () => {
    await startFakeServer((hello) => ({
      type: 'hello',
      protocolVersion: IPC_PROTOCOL_VERSION,
      daemonId: DAEMON_ID,
      serverNonce: createNonce(),
      proof: computeProof(
        randomBytes(32),
        'server',
        DAEMON_ID,
        hello['clientNonce'] as string,
        createNonce(),
      ),
    }));
    await expect(connectIpc({ socketPath, key })).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' });
    expectNoSecretLeak();
  });

  it('過去の接続で得た正しいhelloを再生されても信用しない', async () => {
    // 正しいkeyで作ったが、別のclientNonceに対するhello。
    const oldClientNonce = createNonce();
    const oldServerNonce = createNonce();
    const replayed = {
      type: 'hello',
      protocolVersion: IPC_PROTOCOL_VERSION,
      daemonId: DAEMON_ID,
      serverNonce: oldServerNonce,
      proof: computeProof(key, 'server', DAEMON_ID, oldClientNonce, oldServerNonce),
    };
    await startFakeServer(() => replayed);
    await expect(connectIpc({ socketPath, key })).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' });
    expectNoSecretLeak();
  });

  it('別のprotocolVersionを名乗るserverを明示errorで拒否する', async () => {
    await startFakeServer(() => ({
      type: 'hello',
      protocolVersion: 2,
      daemonId: DAEMON_ID,
      serverNonce: createNonce(),
      proof: 'ab'.repeat(32),
    }));
    await expect(connectIpc({ socketPath, key })).rejects.toMatchObject({
      code: 'E_PROTOCOL_MISMATCH',
    });
    expectNoSecretLeak();
  });

  it('認証前は、clientも4KiBを超えるframeを受け取らない', async () => {
    await startFakeServer((hello) => {
      const serverNonce = createNonce();
      return {
        type: 'hello',
        protocolVersion: IPC_PROTOCOL_VERSION,
        daemonId: DAEMON_ID,
        serverNonce,
        // 正しいproofを付けても、frameが大きすぎれば相手を確認する前に切断する。
        proof: computeProof(key, 'server', DAEMON_ID, hello['clientNonce'] as string, serverNonce),
        padding: 'x'.repeat(LIMITS.ipcPreAuthFrameBytes),
      };
    });
    await expect(connectIpc({ socketPath, key })).rejects.toMatchObject({
      code: 'E_DAEMON_UNAVAILABLE',
    });
    expectNoSecretLeak();
  });

  it('同じclientNonceでも接続ごとにserverNonceが変わり、proofを使い回せない', async () => {
    const clientNonce = createNonce();
    const hello = encodeFrame({
      type: 'hello',
      protocolVersion: IPC_PROTOCOL_VERSION,
      clientNonce,
    });
    const first = await rawExchange([hello]);
    const second = await rawExchange([hello]);
    const proofOf = (received: string) =>
      (JSON.parse(received.split('\n')[0] as string) as { proof: string }).proof;
    expect(proofOf(first.received)).not.toBe(proofOf(second.received));
  });
});
