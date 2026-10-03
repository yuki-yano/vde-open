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
      if (method === 'fail') throw new VdeError('E_DOCUMENT_NOT_FOUND', 'Not found.');
      if (method === 'crash') throw new Error('internal details');
      // A handler that never responds. Released in the test teardown.
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

// Sends arbitrary bytes and returns what was received until the peer closes.
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

describe('IPC happy path', () => {
  it('sends a request after authentication and receives the same envelope as the CLI', async () => {
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

  it('does not return the details of unexpected exceptions to the peer', async () => {
    const connection = await connectIpc({ socketPath, key });
    try {
      const envelope = await connection.request('crash', {});
      expect(envelope).toMatchObject({ ok: false, error: { code: 'E_INTERNAL' } });
      expect(JSON.stringify(envelope)).not.toContain('internal details');
    } finally {
      connection.close();
    }
  });

  it.skipIf(process.platform === 'win32')('the socket is accessible only by its owner', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});

describe('request timeouts and cleanup', () => {
  it('rejects on timeout when there is no response, and the connection stays usable', async () => {
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

  it('rejects pending requests when closed explicitly', async () => {
    const connection = await connectIpc({ socketPath, key });
    const waiting = connection.request('hang', {});
    connection.close();
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' });
    await expect(connection.request('ping', {})).rejects.toMatchObject({
      code: 'E_DAEMON_UNAVAILABLE',
    });
  });

  it('rejects pending requests when the server drops the connection', async () => {
    const connection = await connectIpc({ socketPath, key });
    const waiting = connection.request('hang', {});
    await server?.close();
    server = null;
    await expect(waiting).rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' });
  });

  it('drain waits until in-flight requests have finished responding', async () => {
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

describe('aborting a connection', () => {
  const abortListeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;

  it('leaves no listeners from failed connections, however many times the same signal fails to connect', async () => {
    const controller = new AbortController();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        connectIpc({ socketPath: join(dir, 'missing.sock'), key, signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' });
    }
    expect(abortListeners(controller.signal)).toBe(0);
    // None left after the handshake finishes either.
    const connection = await connectIpc({ socketPath, key, signal: controller.signal });
    connection.close();
    expect(abortListeners(controller.signal)).toBe(0);
  });

  it('fails without connecting on an already aborted signal, and leaves no listeners', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(connectIpc({ socketPath, key, signal: controller.signal })).rejects.toMatchObject({
      code: 'E_DAEMON_UNAVAILABLE',
    });
    expect(abortListeners(controller.signal)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('client shutdown against an unresponsive peer', () => {
  it('the process exits if the connection is closed after the timeout, even when the peer ignores the disconnect', async () => {
    // A server that responds correctly through authentication, then returns nothing and ignores the peer's disconnect.
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
      // The server ignores disconnects, so destroy the accepted connections here before closing.
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => unresponsive.close(() => resolve()));
    }
  });
});

describe('SYS-004 IPC before authentication', () => {
  it('rejects a regular method before authentication, disconnects, and does not call the handler', async () => {
    const result = await rawExchange([
      encodeFrame({ id: 'x', method: 'documents.list', params: {} }),
    ]);
    expect(result.closed).toBe(true);
    expect(result.received).toContain('E_UNAUTHORIZED');
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('disconnects on a frame over 4KiB before authentication', async () => {
    const huge = Buffer.alloc(LIMITS.ipcPreAuthFrameBytes + 1, 0x61);
    const result = await rawExchange([huge]);
    expect(result.closed).toBe(true);
    expect(result.received).toBe('');
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('disconnects on invalid JSON', async () => {
    const result = await rawExchange([Buffer.from('{"type":"hello",\n', 'utf8')]);
    expect(result.closed).toBe(true);
    expect(calls).toEqual([]);
    await expectServerAlive();
  });

  it('does not authenticate with a wrong proof, and does not process the following method', async () => {
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

  it('rejects a client with a different protocolVersion with an explicit error', async () => {
    const result = await rawExchange([
      encodeFrame({ type: 'hello', protocolVersion: 2, clientNonce: createNonce() }),
    ]);
    expect(result.closed).toBe(true);
    expect(result.received).toContain('E_PROTOCOL_MISMATCH');
    await expectServerAlive();
  });
});

describe('SYS-005 verifying the peer', () => {
  let fake: Server | null = null;
  let fakeReceived: Buffer[];

  // Stop the real daemon and let a fake server listen on the same socket.
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
    // The peer is not verified, so the client's proof is not sent either.
    expect(wire.toString('utf8')).not.toContain('"auth"');
  }

  it('does not trust the proof of a fake server without the key, and sends neither the key nor a proof', async () => {
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

  it('does not trust a replayed valid hello from a past connection', async () => {
    // A hello made with the correct key, but for a different clientNonce.
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

  it('rejects a server claiming a different protocolVersion with an explicit error', async () => {
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

  it('before authentication, the client also rejects frames over 4KiB', async () => {
    await startFakeServer((hello) => {
      const serverNonce = createNonce();
      return {
        type: 'hello',
        protocolVersion: IPC_PROTOCOL_VERSION,
        daemonId: DAEMON_ID,
        serverNonce,
        // Even with a correct proof, an oversized frame disconnects before the peer is verified.
        proof: computeProof(key, 'server', DAEMON_ID, hello['clientNonce'] as string, serverNonce),
        padding: 'x'.repeat(LIMITS.ipcPreAuthFrameBytes),
      };
    });
    await expect(connectIpc({ socketPath, key })).rejects.toMatchObject({
      code: 'E_DAEMON_UNAVAILABLE',
    });
    expectNoSecretLeak();
  });

  it('the serverNonce changes per connection even with the same clientNonce, so proofs cannot be reused', async () => {
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
