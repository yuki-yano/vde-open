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
}

export interface IpcRequestOptions {
  // 応答を待つ上限。既定はDEFAULT_REQUEST_TIMEOUT_MS。
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
    // 相手を確認するまでは、serverと同じく小さいframeしか受け取らない。
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
      rejectPending(error);
      socket.destroy();
    };

    const timer = setTimeout(() => {
      failAll(unavailable('daemonとの接続確認が時間内に終わりませんでした。'));
    }, options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);

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
            rejectRequest(unavailable('daemonとの接続が閉じています。'));
            return;
          }
          const id = randomUUID();
          const requestTimer = setTimeout(() => {
            pending.delete(id);
            rejectRequest(unavailable('daemonが時間内に応答しませんでした。'));
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
        // 応答を待っているrequestを残さない。相手が応答不能でも接続を手放せるよう、
        // 相手からの切断を待たずに破棄する。
        phase = 'closed';
        clearTimeout(timer);
        rejectPending(unavailable('daemonとの接続を閉じました。'));
        socket.destroy();
      },
    };

    const handleFrame = (frame: Record<string, unknown>) => {
      if (frame['type'] === 'error') {
        const code =
          frame['code'] === 'E_PROTOCOL_MISMATCH' ? 'E_PROTOCOL_MISMATCH' : 'E_UNAUTHORIZED';
        failAll(
          new VdeError(code, 'daemonが接続を拒否しました。', { code: String(frame['code']) }),
        );
        return;
      }
      if (phase === 'await-hello') {
        if (frame['type'] !== 'hello' || frame['protocolVersion'] !== IPC_PROTOCOL_VERSION) {
          failAll(
            new VdeError('E_PROTOCOL_MISMATCH', 'daemonのprotocolVersionが一致しません。', {
              expected: IPC_PROTOCOL_VERSION,
            }),
          );
          return;
        }
        const { daemonId: id, serverNonce, proof } = frame;
        if (typeof id !== 'string' || typeof serverNonce !== 'string') {
          failAll(new VdeError('E_UNAUTHORIZED', '接続相手を確認できません。'));
          return;
        }
        // 相手がkeyを持つことを確かめてから、こちらのproofを送る。
        if (
          !proofMatches(computeProof(options.key, 'server', id, clientNonce, serverNonce), proof)
        ) {
          failAll(new VdeError('E_UNAUTHORIZED', '接続相手を確認できません。'));
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
          failAll(new VdeError('E_UNAUTHORIZED', '認証に失敗しました。'));
          return;
        }
        phase = 'ready';
        clearTimeout(timer);
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
      else waiter.reject(new VdeError('E_PROTOCOL_MISMATCH', 'daemonの応答を解釈できません。'));
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
        failAll(unavailable('daemonの応答が不正です。', error));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      failAll(unavailable('daemonへ接続できません。', error));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (phase !== 'closed') failAll(unavailable('daemonとの接続が切れました。'));
    });
  });
}
