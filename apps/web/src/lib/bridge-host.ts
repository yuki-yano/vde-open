// The host side of the communication between the HTML and the management UI (spec 11.6, 11.7).
// Frames from the HTML are validated by size, count, order, view identifier, operation, and payload shape,
// and only fetching the draft answer (ready) and replacing it (updateDraft) are allowed. Submitting, acknowledging, cancelling, searching, reading, and so on are rejected.
// Whatever arrives from the HTML is treated as a draft answer, never as the user's final answer (spec 11.8).
import {
  answersSchema,
  BRIDGE_PROTOCOL_VERSION,
  LIMITS,
  utf8Length,
  type Answers,
  type Questionnaire,
} from '@vde-open/shared';

import { ApiError } from './api.ts';

// The part of MessagePort that is used.
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
  // Replace the draft answer. baseDraftVersion is used exactly as the HTML passed it (not reinterpreted as the latest version).
  updateDraft(answers: Answers, baseDraftVersion: number): Promise<{ draftVersion: number }>;
}

// Why the communication ended.
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
  // Tell the HTML about draft-answer changes made by anyone other than this HTML.
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

// Size as JSON (UTF-8). null for values that cannot be serialized to JSON.
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
  return { code: 'E_BRIDGE_FAILED', message: 'Could not handle the draft answer.' };
}

export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { instanceId, port, handlers } = options;
  const now = options.now ?? Date.now;
  let closed = false;
  let lastSequence = 0;
  let received: number[] = [];
  // Versions created by this HTML's updateDraft, and the latest version the HTML knows of.
  const ownVersions = new Set<number>();
  let knownVersion = -1;
  // Changes that arrive while an updateDraft response is pending are delivered after the response (so the HTML's own change is not reported to it).
  let updating = 0;
  let deferred: { answers: Answers; draftVersion: number } | null = null;

  const send = (message: Record<string, unknown>): void => {
    if (closed) return;
    const bytes = jsonBytes(message);
    if (bytes === null || bytes > LIMITS.bridgeOutboundFrameBytes) {
      // Do not send a response over the limit; return a failure instead.
      if (message['type'] === 'response') {
        port.postMessage({
          type: 'response',
          sequence: message['sequence'],
          ok: false,
          error: { code: 'E_LIMIT_EXCEEDED', message: 'The response is too large.' },
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
        reject(sequence, 'E_INVALID_ARGUMENT', 'ready takes no arguments.');
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
          'updateDraft requires a draft-answer object and baseDraftVersion.',
        );
        return;
      }
      const bytes = jsonBytes(answers);
      if (bytes === null || bytes > LIMITS.answerBytes) {
        reject(sequence, 'E_LIMIT_EXCEEDED', 'The draft answer is too large.');
        return;
      }
      // Validate the value as received. Do not let JSON conversion change types or drop values (spec 11.2).
      if (Object.hasOwn(answers, '__proto__') || !answersSchema.safeParse(answers).success) {
        reject(
          sequence,
          'E_ANSWER_INVALID',
          'Draft answer values must be strings, finite numbers, booleans, or arrays of strings, keyed by field name.',
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
    // Submitting, acknowledging, cancelling, searching, reading, and so on cannot be done from the HTML (spec 11.6).
    reject(sequence, 'E_METHOD_NOT_ALLOWED', `${method.slice(0, 64)} cannot be called from HTML.`);
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
        // Close even if the other side is gone.
      }
      closed = true;
      port.removeEventListener('message', onMessage);
      port.close();
      options.onClose?.(reason);
    },
  };

  function onMessage(event: MessageEvent): void {
    if (closed) return;
    // Count before checking the shape (a flood of malformed frames still hits the limit).
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
    // A frame from another view (an old instance) or an out-of-order frame ends the whole communication.
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
