import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import {
  errorEnvelope,
  IPC_PROTOCOL_VERSION,
  isVdeError,
  LIMITS,
  successEnvelope,
  VdeError,
  type ErrorBody,
  type Warning,
} from '@vde-open/shared';

import {
  computeProof,
  createNonce,
  HANDSHAKE_TIMEOUT_MS,
  isNonce,
  proofMatches,
} from './ipc-auth.ts';
import { encodeFrame, FrameDecoder, FrameError } from './ipc-frames.ts';

export interface IpcHandlerResult {
  data: unknown;
  catalogVersion?: number;
  warnings?: Warning[];
}

export interface IpcServerOptions {
  socketPath: string;
  key: Buffer;
  daemonId: string;
  handle: (method: string, params: unknown) => Promise<IpcHandlerResult>;
  // Receives only events that carry no content.
  onEvent?: (event: string, fields: Record<string, string | number>) => void;
}

export interface IpcServer {
  // Waits until every in-flight request has finished responding.
  drain(): Promise<void>;
  close(): Promise<void>;
}

type ConnectionPhase = 'await-hello' | 'await-auth' | 'ready';

function toErrorBody(error: unknown): ErrorBody {
  if (isVdeError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  // Do not return the details of unexpected exceptions to the peer.
  return {
    code: 'E_INTERNAL',
    message: 'An internal error occurred.',
    retryable: false,
    details: {},
  };
}

function serveConnection(
  socket: Socket,
  options: IpcServerOptions,
  inFlight: Set<Promise<void>>,
): void {
  let phase: ConnectionPhase = 'await-hello';
  let clientNonce = '';
  let serverNonce = '';
  const decoder = new FrameDecoder(() =>
    phase === 'ready' ? LIMITS.ipcFrameBytes : LIMITS.ipcPreAuthFrameBytes,
  );

  const reject = (code: 'E_UNAUTHORIZED' | 'E_PROTOCOL_MISMATCH', message: string) => {
    options.onEvent?.('ipc.rejected', { code, phase });
    socket.end(encodeFrame({ type: 'error', code, message }));
  };

  const handshakeTimer = setTimeout(() => {
    if (phase !== 'ready') socket.destroy();
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();

  const respond = (id: unknown, body: Record<string, unknown>) => {
    if (!socket.writable) return;
    socket.write(encodeFrame({ id, ...body }));
  };

  const handleRequest = (frame: Record<string, unknown>) => {
    const { id, method, params } = frame;
    if (typeof id !== 'string' || typeof method !== 'string') {
      respond(typeof id === 'string' ? id : null, {
        ...errorEnvelope(
          toErrorBody(new VdeError('E_INVALID_ARGUMENT', 'The request requires id and method.')),
        ),
      });
      return;
    }
    const startedAt = Date.now();
    const run = async () => {
      try {
        const result = await options.handle(method, params);
        const meta =
          result.catalogVersion === undefined
            ? { command: method }
            : { command: method, catalogVersion: result.catalogVersion };
        respond(id, { ...successEnvelope(result.data, meta, result.warnings ?? []) });
        options.onEvent?.('ipc.request', { method, ok: 1, ms: Date.now() - startedAt });
      } catch (error) {
        const body = toErrorBody(error);
        respond(id, { ...errorEnvelope(body) });
        options.onEvent?.('ipc.request', {
          method,
          ok: 0,
          code: body.code,
          ms: Date.now() - startedAt,
        });
      }
    };
    const task = run();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  const handleFrame = (frame: Record<string, unknown>) => {
    if (phase === 'await-hello') {
      if (frame['type'] !== 'hello' || !isNonce(frame['clientNonce'])) {
        reject('E_UNAUTHORIZED', 'Frames before authentication are not accepted.');
        return;
      }
      if (frame['protocolVersion'] !== IPC_PROTOCOL_VERSION) {
        reject('E_PROTOCOL_MISMATCH', 'The IPC protocolVersion does not match.');
        return;
      }
      clientNonce = frame['clientNonce'];
      serverNonce = createNonce();
      phase = 'await-auth';
      socket.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: IPC_PROTOCOL_VERSION,
          daemonId: options.daemonId,
          serverNonce,
          proof: computeProof(options.key, 'server', options.daemonId, clientNonce, serverNonce),
        }),
      );
      return;
    }
    if (phase === 'await-auth') {
      const expected = computeProof(
        options.key,
        'client',
        options.daemonId,
        clientNonce,
        serverNonce,
      );
      if (frame['type'] !== 'auth' || !proofMatches(expected, frame['proof'])) {
        reject('E_UNAUTHORIZED', 'Authentication failed.');
        return;
      }
      phase = 'ready';
      clearTimeout(handshakeTimer);
      socket.write(encodeFrame({ type: 'auth-ok' }));
      return;
    }
    handleRequest(frame);
  };

  socket.on('data', (chunk: Buffer) => {
    let frames: Array<Record<string, unknown>>;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      // On oversized frames and invalid JSON, close the connection without responding.
      options.onEvent?.('ipc.frame-error', {
        kind: error instanceof FrameError ? error.kind : 'unknown',
        phase,
      });
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (socket.destroyed || !socket.writable) return;
      handleFrame(frame);
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => clearTimeout(handshakeTimer));
}

export async function startIpcServer(options: IpcServerOptions): Promise<IpcServer> {
  const sockets = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, options, inFlight);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(options.socketPath, 0o600);

  return {
    drain: async () => {
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
