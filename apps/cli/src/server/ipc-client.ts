import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import {
  envelopeSchema,
  IPC_PROTOCOL_VERSION,
  LIMITS,
  VdeError,
  type Envelope,
} from '@vde-open/shared';

import { computeProof, createNonce, HANDSHAKE_TIMEOUT_MS, proofMatches } from './ipc-auth.ts';
import { encodeFrame, FrameDecoder } from './ipc-frames.ts';

export interface IpcConnectOptions {
  socketPath: string;
  key: Buffer;
  timeoutMs?: number;
  // When aborted, fail without waiting for the handshake and clean up the socket and timer.
  signal?: AbortSignal;
}

export interface IpcRequestOptions {
  // Maximum time to wait for a response. Defaults to DEFAULT_REQUEST_TIMEOUT_MS.
  timeoutMs?: number;
}

export interface IpcConnection {
  readonly daemonId: string;
  request<T>(method: string, params: unknown, options?: IpcRequestOptions): Promise<Envelope<T>>;
  close(): void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function unavailable(message: string, cause?: unknown): VdeError {
  return new VdeError('E_DAEMON_UNAVAILABLE', message, {}, { cause });
}

export function connectIpc(options: IpcConnectOptions): Promise<IpcConnection> {
  return new Promise<IpcConnection>((resolve, reject) => {
    const socket: Socket = connect(options.socketPath);
    const clientNonce = createNonce();
    // Until the peer is verified, accept only small frames, as the server does.
    const decoder = new FrameDecoder(() =>
      phase === 'ready' ? LIMITS.ipcFrameBytes : LIMITS.ipcPreAuthFrameBytes,
    );
    const pending = new Map<
      string,
      {
        resolve: (envelope: Envelope<unknown>) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    let phase: 'await-hello' | 'await-auth-ok' | 'ready' | 'closed' = 'await-hello';
    let daemonId = '';

    const rejectPending = (error: Error) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      pending.clear();
    };

    const failAll = (error: Error) => {
      if (phase !== 'ready') reject(error);
      phase = 'closed';
      clearTimeout(timer);
      // The same signal may be used to reconnect, so do not leave listeners from a failed connection.
      options.signal?.removeEventListener('abort', onAbort);
      rejectPending(error);
      socket.destroy();
    };

    const timer = setTimeout(() => {
      failAll(unavailable('The handshake with the daemon did not finish in time.'));
    }, options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    // Abort is honored only until the handshake finishes. After that, the caller closes.
    const onAbort = () => {
      if (phase !== 'ready') failAll(unavailable('The connection to the daemon was aborted.'));
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const connection: IpcConnection = {
      get daemonId() {
        return daemonId;
      },
      request<T>(
        method: string,
        params: unknown,
        requestOptions: IpcRequestOptions = {},
      ): Promise<Envelope<T>> {
        return new Promise<Envelope<T>>((resolveRequest, rejectRequest) => {
          if (phase !== 'ready') {
            rejectRequest(unavailable('The connection to the daemon is closed.'));
            return;
          }
          const id = randomUUID();
          const requestTimer = setTimeout(() => {
            pending.delete(id);
            rejectRequest(unavailable('The daemon did not respond in time.'));
          }, requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
          pending.set(id, {
            resolve: (envelope) => resolveRequest(envelope as Envelope<T>),
            reject: rejectRequest,
            timer: requestTimer,
          });
          socket.write(encodeFrame({ id, method, params }));
        });
      },
      close() {
        // Do not leave requests waiting for a response. Destroy without waiting for the peer
        // to disconnect, so the connection can be released even if the peer is unresponsive.
        phase = 'closed';
        clearTimeout(timer);
        rejectPending(unavailable('The connection to the daemon was closed.'));
        socket.destroy();
      },
    };

    const handleFrame = (frame: Record<string, unknown>) => {
      if (frame['type'] === 'error') {
        const code =
          frame['code'] === 'E_PROTOCOL_MISMATCH' ? 'E_PROTOCOL_MISMATCH' : 'E_UNAUTHORIZED';
        failAll(
          new VdeError(code, 'The daemon refused the connection.', { code: String(frame['code']) }),
        );
        return;
      }
      if (phase === 'await-hello') {
        if (frame['type'] !== 'hello' || frame['protocolVersion'] !== IPC_PROTOCOL_VERSION) {
          failAll(
            new VdeError(
              'E_PROTOCOL_MISMATCH',
              'The protocolVersion of the daemon does not match.',
              {
                expected: IPC_PROTOCOL_VERSION,
              },
            ),
          );
          return;
        }
        const { daemonId: id, serverNonce, proof } = frame;
        if (typeof id !== 'string' || typeof serverNonce !== 'string') {
          failAll(new VdeError('E_UNAUTHORIZED', 'The peer could not be verified.'));
          return;
        }
        // Verify that the peer holds the key before sending our proof.
        if (
          !proofMatches(computeProof(options.key, 'server', id, clientNonce, serverNonce), proof)
        ) {
          failAll(new VdeError('E_UNAUTHORIZED', 'The peer could not be verified.'));
          return;
        }
        daemonId = id;
        phase = 'await-auth-ok';
        socket.write(
          encodeFrame({
            type: 'auth',
            proof: computeProof(options.key, 'client', id, clientNonce, serverNonce),
          }),
        );
        return;
      }
      if (phase === 'await-auth-ok') {
        if (frame['type'] !== 'auth-ok') {
          failAll(new VdeError('E_UNAUTHORIZED', 'Authentication failed.'));
          return;
        }
        phase = 'ready';
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(connection);
        return;
      }
      const id = frame['id'];
      if (typeof id !== 'string') return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      clearTimeout(waiter.timer);
      const { id: _id, ...body } = frame;
      const parsed = envelopeSchema.safeParse(body);
      if (parsed.success) waiter.resolve(parsed.data);
      else
        waiter.reject(
          new VdeError('E_PROTOCOL_MISMATCH', 'The response from the daemon could not be parsed.'),
        );
    };

    socket.on('connect', () => {
      socket.write(
        encodeFrame({ type: 'hello', protocolVersion: IPC_PROTOCOL_VERSION, clientNonce }),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (phase === 'closed') return;
          handleFrame(frame);
        }
      } catch (error) {
        failAll(unavailable('The response from the daemon is invalid.', error));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      failAll(unavailable('Could not connect to the daemon.', error));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (phase !== 'closed') failAll(unavailable('The connection to the daemon was lost.'));
    });
  });
}
