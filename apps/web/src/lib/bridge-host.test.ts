import type { Answers, Questionnaire } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api.ts';
import {
  createBridgeHost,
  type BridgeCloseReason,
  type BridgeHandlers,
  type BridgePort,
} from './bridge-host.ts';

const INSTANCE = 'instance-1';

class FakePort implements BridgePort {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  #listener: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  start(): void {}
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.#listener = listener;
  }
  removeEventListener(): void {
    this.#listener = null;
  }
  deliver(data: unknown): void {
    this.#listener?.({ data } as MessageEvent);
  }
  responses() {
    return this.sent.filter((message) => message['type'] === 'response');
  }
}

interface Setup {
  port: FakePort;
  calls: Array<{ method: string; args: unknown[] }>;
  closes: BridgeCloseReason[];
  host: ReturnType<typeof createBridgeHost>;
  clock: { now: number };
  release: Array<(version: number) => void>;
}

function setup(overrides: Partial<BridgeHandlers> = {}): Setup {
  const port = new FakePort();
  const calls: Setup['calls'] = [];
  const closes: BridgeCloseReason[] = [];
  const clock = { now: 1_000_000 };
  const release: Setup['release'] = [];
  const handlers: BridgeHandlers = {
    ready: () => {
      calls.push({ method: 'ready', args: [] });
      return Promise.resolve({
        protocolVersion: 1,
        requestId: 'req_1',
        documentId: 'doc_1',
        revision: 'rev_1',
        questionnaire: {} as Questionnaire,
        draftVersion: 2,
        answers: {},
      });
    },
    updateDraft: (answers: Answers, base: number) => {
      calls.push({ method: 'updateDraft', args: [answers, base] });
      return new Promise((resolve) => {
        release.push((draftVersion) => resolve({ draftVersion }));
      });
    },
    ...overrides,
  };
  const host = createBridgeHost({
    instanceId: INSTANCE,
    port,
    handlers,
    now: () => clock.now,
    onClose: (reason) => closes.push(reason),
  });
  return { port, calls, closes, host, clock, release };
}

const frame = (sequence: number, method: string, payload: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  instanceId: INSTANCE,
  sequence,
  method,
  payload,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('FB-008 operations allowed from the HTML', () => {
  it('performs only ready and updateDraft, using baseDraftVersion exactly as the HTML passed it', async () => {
    const { port, calls, release } = setup();
    port.deliver(frame(1, 'ready'));
    port.deliver(frame(2, 'updateDraft', { answers: { layout: 'A' }, baseDraftVersion: 0 }));
    await flush();
    release[0]?.(3);
    await flush();
    expect(calls).toEqual([
      { method: 'ready', args: [] },
      { method: 'updateDraft', args: [{ layout: 'A' }, 0] },
    ]);
    expect(port.responses()).toMatchObject([
      { sequence: 1, ok: true, result: { draftVersion: 2 } },
      { sequence: 2, ok: true, result: { draftVersion: 3 } },
    ]);
  });

  it('rejects submit, ack, cancel, search, read, and older-revision confirmation without calling anything', async () => {
    const { port, calls, closes } = setup();
    const methods = ['submit', 'ack', 'cancel', 'search', 'read', 'open', 'confirmOlderRevision'];
    methods.forEach((method, index) => port.deliver(frame(index + 1, method)));
    await flush();
    expect(calls).toEqual([]);
    expect(closes).toEqual([]);
    expect(port.responses().map((response) => response['error'])).toEqual(
      methods.map(() => expect.objectContaining({ code: 'E_METHOD_NOT_ALLOWED' })),
    );
  });

  it('rejects payloads outside the protocol, such as naming another question, and rejects oversized draft answers', async () => {
    const { port, calls } = setup();
    port.deliver(
      frame(1, 'updateDraft', { answers: {}, baseDraftVersion: 0, requestId: 'req_other' }),
    );
    port.deliver(frame(2, 'updateDraft', { answers: [], baseDraftVersion: 0 }));
    port.deliver(frame(3, 'updateDraft', { answers: {}, baseDraftVersion: -1 }));
    port.deliver(frame(4, 'ready', { requestId: 'req_other' }));
    port.deliver(
      frame(5, 'updateDraft', { answers: { note: 'x'.repeat(64 * 1024) }, baseDraftVersion: 0 }),
    );
    await flush();
    expect(calls).toEqual([]);
    expect(
      port.responses().map((response) => (response['error'] as { code: string }).code),
    ).toEqual([
      'E_INVALID_ARGUMENT',
      'E_INVALID_ARGUMENT',
      'E_INVALID_ARGUMENT',
      'E_INVALID_ARGUMENT',
      'E_LIMIT_EXCEEDED',
    ]);
  });

  it.each([
    ['Date', { note: new Date(0) }],
    ['undefined', { note: undefined }],
    ['NaN', { score: Number.NaN }],
    ['Infinity', { score: Number.POSITIVE_INFINITY }],
    ['a nested object', { note: { text: 'x' } }],
    ['an array of non-strings', { tags: [1, 2] }],
    ['an invalid field name', { '1note': 'x' }],
    ['__proto__', JSON.parse('{"__proto__": "x"}') as Record<string, unknown>],
  ])(
    'rejects a draft answer containing %s without changing types or dropping values',
    async (_name, answers) => {
      const { port, calls } = setup();
      port.deliver(frame(1, 'updateDraft', { answers, baseDraftVersion: 0 }));
      await flush();
      expect(calls).toEqual([]);
      expect(port.responses()).toMatchObject([
        { sequence: 1, ok: false, error: { code: 'E_ANSWER_INVALID' } },
      ]);
    },
  );

  it('returns save failures to the HTML with their code', async () => {
    const { port } = setup({
      updateDraft: () =>
        Promise.reject(
          new ApiError('E_DRAFT_CONFLICT', 'Another window updated it first.', 409, {}),
        ),
    });
    port.deliver(frame(1, 'updateDraft', { answers: {}, baseDraftVersion: 0 }));
    await flush();
    expect(port.responses()).toMatchObject([
      { sequence: 1, ok: false, error: { code: 'E_DRAFT_CONFLICT' } },
    ]);
  });
});

describe('FB-009 / FB-010 frame validation', () => {
  it.each([
    ['not an object', 'not a frame'],
    ['has a different protocolVersion', { ...frame(1, 'ready'), protocolVersion: 2 }],
    ['has no payload', { protocolVersion: 1, instanceId: INSTANCE, sequence: 1, method: 'ready' }],
    ['has a non-integer sequence', { ...frame(1, 'ready'), sequence: 1.5 }],
    ['cannot be serialized to JSON', { ...frame(1, 'ready'), payload: { value: 1n } }],
  ])('a frame that is %s ends the communication', async (_name, data) => {
    const { port, calls, closes } = setup();
    port.deliver(data);
    port.deliver(frame(2, 'ready'));
    await flush();
    expect(closes).toEqual(['malformed']);
    expect(port.closed).toBe(true);
    expect(calls).toEqual([]);
    expect(port.sent.at(-1)).toEqual({ type: 'closed', reason: 'malformed' });
  });

  it('a frame over 128KiB ends the communication; one within 128KiB is accepted', async () => {
    const big = setup();
    big.port.deliver(
      frame(1, 'updateDraft', { answers: { note: 'x'.repeat(128 * 1024) }, baseDraftVersion: 0 }),
    );
    expect(big.closes).toEqual(['too-large']);
    const fits = setup();
    fits.port.deliver(
      frame(1, 'updateDraft', { answers: { note: 'x'.repeat(60 * 1024) }, baseDraftVersion: 0 }),
    );
    await flush();
    expect(fits.closes).toEqual([]);
    expect(fits.calls).toHaveLength(1);
  });

  it('more than 20 frames per second ends the communication; the count resets after a gap', async () => {
    const { port, closes, clock } = setup();
    for (let sequence = 1; sequence <= 20; sequence += 1) port.deliver(frame(sequence, 'ready'));
    expect(closes).toEqual([]);
    clock.now += 1000;
    for (let sequence = 21; sequence <= 40; sequence += 1) port.deliver(frame(sequence, 'ready'));
    expect(closes).toEqual([]);
    port.deliver(frame(41, 'ready'));
    expect(closes).toEqual(['rate']);
  });

  it('a frame from another view (an old instance) or an out-of-order frame ends the communication', () => {
    const old = setup();
    old.port.deliver({ ...frame(1, 'ready'), instanceId: 'instance-0' });
    expect(old.closes).toEqual(['instance']);
    const reordered = setup();
    reordered.port.deliver(frame(5, 'ready'));
    reordered.port.deliver(frame(5, 'ready'));
    expect(reordered.closes).toEqual(['sequence']);
  });

  it('does not process frames after closing', async () => {
    const { port, host, calls } = setup();
    host.close('replaced');
    port.deliver(frame(1, 'ready'));
    await flush();
    expect(calls).toEqual([]);
  });
});

describe('FB-011 notifying the HTML of draft changes from other windows', () => {
  it('does not report versions created by its own updateDraft, and reports other changes only without going back to an older version', async () => {
    const { port, host, release } = setup();
    port.deliver(frame(1, 'ready'));
    await flush();
    // Versions up to the one received by ready (2) are not reported.
    host.notifyDraft({ answers: { layout: 'A' }, draftVersion: 2 });
    host.notifyDraft({ answers: { layout: 'B' }, draftVersion: 3 });
    // A notification that arrives while waiting for its own save response is reported after the response, unless it is its own version.
    port.deliver(frame(2, 'updateDraft', { answers: { layout: 'A' }, baseDraftVersion: 3 }));
    host.notifyDraft({ answers: { layout: 'A' }, draftVersion: 4 });
    release[0]?.(4);
    await flush();
    host.notifyDraft({ answers: { layout: 'B' }, draftVersion: 5 });
    host.notifyDraft({ answers: { layout: 'A' }, draftVersion: 4 });
    expect(port.sent.filter((message) => message['type'] === 'event')).toEqual([
      {
        type: 'event',
        method: 'draftChanged',
        payload: { answers: { layout: 'B' }, draftVersion: 3 },
      },
      {
        type: 'event',
        method: 'draftChanged',
        payload: { answers: { layout: 'B' }, draftVersion: 5 },
      },
    ]);
  });

  it('does not send a response over the limit and returns a failure instead', async () => {
    const { port } = setup({
      ready: () =>
        Promise.resolve({
          protocolVersion: 1,
          requestId: 'req_1',
          documentId: 'doc_1',
          revision: 'rev_1',
          questionnaire: { title: 'x'.repeat(260 * 1024) } as unknown as Questionnaire,
          draftVersion: 0,
          answers: {},
        }),
    });
    port.deliver(frame(1, 'ready'));
    await flush();
    expect(port.responses()).toMatchObject([
      { sequence: 1, ok: false, error: { code: 'E_LIMIT_EXCEEDED' } },
    ]);
  });
});
