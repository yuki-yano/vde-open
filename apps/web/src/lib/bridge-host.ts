// HTMLと本体の間の通信の、本体側（仕様11.6・11.7）。
// HTMLから届くframeを、大きさ・件数・順番・表示の識別子・操作・payloadの形で検証し、
// 回答案の取得（ready）と置き換え（updateDraft）だけを行う。送信・取得済みの印・中止・検索・読み取りなどは拒否する。
// HTMLから届くものは、利用者の確定ではなく、あくまで回答案として扱う（仕様11.8）。
import {
  answersSchema,
  BRIDGE_PROTOCOL_VERSION,
  LIMITS,
  utf8Length,
  type Answers,
  type Questionnaire,
} from '@vde-open/shared';

import { ApiError } from './api.ts';

// MessagePortのうち、使う部分。
export interface BridgePort {
  postMessage(message: unknown): void;
  close(): void;
  start(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface ReadyResult {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  documentId: string;
  revision: string;
  questionnaire: Questionnaire;
  draftVersion: number;
  answers: Answers;
}

export interface BridgeHandlers {
  ready(): Promise<ReadyResult>;
  // 回答案を置き換える。baseDraftVersionは、HTMLが渡した値をそのまま使う（最新の版へ読み替えない）。
  updateDraft(answers: Answers, baseDraftVersion: number): Promise<{ draftVersion: number }>;
}

// 通信を終えた理由。
export type BridgeCloseReason =
  | 'malformed'
  | 'too-large'
  | 'rate'
  | 'sequence'
  | 'instance'
  | 'request-closed'
  | 'navigated'
  | 'expired'
  | 'replaced';

export interface BridgeHost {
  // 自分（このHTML）以外による回答案の変更を、HTMLへ知らせる。
  notifyDraft(draft: { answers: Answers; draftVersion: number }): void;
  close(reason: BridgeCloseReason): void;
  readonly closed: boolean;
}

export interface BridgeHostOptions {
  instanceId: string;
  port: BridgePort;
  handlers: BridgeHandlers;
  now?: () => number;
  onClose?: (reason: BridgeCloseReason) => void;
}

const RATE_WINDOW_MS = 1000;

type Frame = { sequence: number; method: string; payload: Record<string, unknown> };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

// JSONとしての大きさ（UTF-8）。JSONにできない値はnull。
function jsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : utf8Length(text);
  } catch {
    return null;
  }
}

function errorBody(reason: unknown): { code: string; message: string } {
  if (reason instanceof ApiError) return { code: reason.code, message: reason.message };
  return { code: 'E_BRIDGE_FAILED', message: '回答案を扱えませんでした。' };
}

export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { instanceId, port, handlers } = options;
  const now = options.now ?? Date.now;
  let closed = false;
  let lastSequence = 0;
  let received: number[] = [];
  // このHTMLのupdateDraftで作った版と、HTMLが知っている最新の版。
  const ownVersions = new Set<number>();
  let knownVersion = -1;
  // updateDraftの応答を待っている間に届いた変更は、応答の後に知らせる（自分の変更を知らせないため）。
  let updating = 0;
  let deferred: { answers: Answers; draftVersion: number } | null = null;

  const send = (message: Record<string, unknown>): void => {
    if (closed) return;
    const bytes = jsonBytes(message);
    if (bytes === null || bytes > LIMITS.bridgeOutboundFrameBytes) {
      // 上限を超える応答は送らず、失敗として返す。
      if (message['type'] === 'response') {
        port.postMessage({
          type: 'response',
          sequence: message['sequence'],
          ok: false,
          error: { code: 'E_LIMIT_EXCEEDED', message: '応答が大きすぎます。' },
        });
      }
      return;
    }
    port.postMessage(message);
  };

  const respond = (sequence: number, work: Promise<unknown>): Promise<void> =>
    work.then(
      (result) => send({ type: 'response', sequence, ok: true, result }),
      (reason: unknown) =>
        send({ type: 'response', sequence, ok: false, error: errorBody(reason) }),
    );

  const reject = (sequence: number, code: string, message: string) =>
    send({ type: 'response', sequence, ok: false, error: { code, message } });

  const deliver = (draft: { answers: Answers; draftVersion: number }) => {
    if (closed || draft.draftVersion <= knownVersion || ownVersions.has(draft.draftVersion)) return;
    knownVersion = draft.draftVersion;
    send({ type: 'event', method: 'draftChanged', payload: draft });
  };

  const dispatch = ({ sequence, method, payload }: Frame): void => {
    if (method === 'ready') {
      if (!hasOnlyKeys(payload, [])) {
        reject(sequence, 'E_INVALID_ARGUMENT', 'readyには引数を渡しません。');
        return;
      }
      void respond(
        sequence,
        handlers.ready().then((result) => {
          knownVersion = Math.max(knownVersion, result.draftVersion);
          return result;
        }),
      );
      return;
    }
    if (method === 'updateDraft') {
      const { answers, baseDraftVersion } = payload;
      if (
        !hasOnlyKeys(payload, ['answers', 'baseDraftVersion']) ||
        !isPlainObject(answers) ||
        typeof baseDraftVersion !== 'number' ||
        !Number.isSafeInteger(baseDraftVersion) ||
        baseDraftVersion < 0
      ) {
        reject(
          sequence,
          'E_INVALID_ARGUMENT',
          'updateDraftには、回答案のobjectとbaseDraftVersionを渡してください。',
        );
        return;
      }
      const bytes = jsonBytes(answers);
      if (bytes === null || bytes > LIMITS.answerBytes) {
        reject(sequence, 'E_LIMIT_EXCEEDED', '回答案が大きすぎます。');
        return;
      }
      // 受け取った値のまま検証する。JSONへの変換で、型を変えたり値を落としたりしない（仕様11.2）。
      if (Object.hasOwn(answers, '__proto__') || !answersSchema.safeParse(answers).success) {
        reject(
          sequence,
          'E_ANSWER_INVALID',
          '回答案に使えるのは、field名ごとの文字列・有限の数・真偽値・文字列の配列だけです。',
        );
        return;
      }
      updating += 1;
      void respond(
        sequence,
        handlers
          .updateDraft(answers as Answers, baseDraftVersion)
          .then((result) => {
            ownVersions.add(result.draftVersion);
            knownVersion = Math.max(knownVersion, result.draftVersion);
            return result;
          })
          .finally(() => {
            updating -= 1;
            if (updating === 0 && deferred !== null) {
              const pending = deferred;
              deferred = null;
              deliver(pending);
            }
          }),
      );
      return;
    }
    // 送信・取得済みの印・中止・検索・読み取りなどは、HTMLから行えない（仕様11.6）。
    reject(sequence, 'E_METHOD_NOT_ALLOWED', `HTMLからは ${method.slice(0, 64)} を行えません。`);
  };

  const host: BridgeHost = {
    get closed() {
      return closed;
    },
    notifyDraft(draft) {
      if (closed) return;
      if (updating > 0) {
        deferred = draft;
        return;
      }
      deliver(draft);
    },
    close(reason) {
      if (closed) return;
      try {
        port.postMessage({ type: 'closed', reason });
      } catch {
        // 相手がいなくても閉じる。
      }
      closed = true;
      port.removeEventListener('message', onMessage);
      port.close();
      options.onClose?.(reason);
    },
  };

  function onMessage(event: MessageEvent): void {
    if (closed) return;
    // 件数は、形を調べる前に数える（不正なframeを大量に送っても、上限で止まる）。
    const at = now();
    received = received.filter((time) => at - time < RATE_WINDOW_MS);
    received.push(at);
    if (received.length > LIMITS.bridgeMessagesPerSecond) {
      host.close('rate');
      return;
    }
    const data = event.data;
    const bytes = jsonBytes(data);
    if (bytes === null) {
      host.close('malformed');
      return;
    }
    if (bytes > LIMITS.bridgeInboundFrameBytes) {
      host.close('too-large');
      return;
    }
    if (
      !isPlainObject(data) ||
      data['protocolVersion'] !== BRIDGE_PROTOCOL_VERSION ||
      typeof data['sequence'] !== 'number' ||
      !Number.isSafeInteger(data['sequence']) ||
      typeof data['method'] !== 'string' ||
      !isPlainObject(data['payload'])
    ) {
      host.close('malformed');
      return;
    }
    // 別の表示（古いinstance）のframeと、順番の違反は、通信ごと終える。
    if (data['instanceId'] !== instanceId) {
      host.close('instance');
      return;
    }
    if (data['sequence'] <= lastSequence) {
      host.close('sequence');
      return;
    }
    lastSequence = data['sequence'];
    dispatch({ sequence: data['sequence'], method: data['method'], payload: data['payload'] });
  }

  port.addEventListener('message', onMessage);
  port.start();
  return host;
}
