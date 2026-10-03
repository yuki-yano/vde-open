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

describe('FB-008 HTMLから行える操作', () => {
  it('readyとupdateDraftだけを行い、baseDraftVersionはHTMLが渡した値のまま使う', async () => {
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

  it('送信・取得済みの印・中止・検索・読み取り・旧版の確認は拒否し、何も呼ばない', async () => {
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

  it('別の質問の指定など、決まっていないpayloadは拒否する。回答案の大きさも上限で拒否する', async () => {
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
    ['入れ子のobject', { note: { text: 'x' } }],
    ['文字列以外の配列', { tags: [1, 2] }],
    ['field名にできない名前', { '1note': 'x' }],
    ['__proto__', JSON.parse('{"__proto__": "x"}') as Record<string, unknown>],
  ])('回答案の値が%sなら、型を変えたり値を落としたりせずに拒否する', async (_name, answers) => {
    const { port, calls } = setup();
    port.deliver(frame(1, 'updateDraft', { answers, baseDraftVersion: 0 }));
    await flush();
    expect(calls).toEqual([]);
    expect(port.responses()).toMatchObject([
      { sequence: 1, ok: false, error: { code: 'E_ANSWER_INVALID' } },
    ]);
  });

  it('保存の失敗は、codeを付けてHTMLへ返す', async () => {
    const { port } = setup({
      updateDraft: () =>
        Promise.reject(new ApiError('E_DRAFT_CONFLICT', '別の画面が先に更新しました。', 409, {})),
    });
    port.deliver(frame(1, 'updateDraft', { answers: {}, baseDraftVersion: 0 }));
    await flush();
    expect(port.responses()).toMatchObject([
      { sequence: 1, ok: false, error: { code: 'E_DRAFT_CONFLICT' } },
    ]);
  });
});

describe('FB-009 / FB-010 frameの検証', () => {
  it.each([
    ['objectでない', 'not a frame'],
    ['protocolVersionが違う', { ...frame(1, 'ready'), protocolVersion: 2 }],
    ['payloadがない', { protocolVersion: 1, instanceId: INSTANCE, sequence: 1, method: 'ready' }],
    ['sequenceが整数でない', { ...frame(1, 'ready'), sequence: 1.5 }],
    ['JSONにできない', { ...frame(1, 'ready'), payload: { value: 1n } }],
  ])('%sframeは、通信を終える', async (_name, data) => {
    const { port, calls, closes } = setup();
    port.deliver(data);
    port.deliver(frame(2, 'ready'));
    await flush();
    expect(closes).toEqual(['malformed']);
    expect(port.closed).toBe(true);
    expect(calls).toEqual([]);
    expect(port.sent.at(-1)).toEqual({ type: 'closed', reason: 'malformed' });
  });

  it('128KiBを超えるframeは、通信を終える。128KiB以内なら受け付ける', async () => {
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

  it('1秒に20件を超えたら、通信を終える。間隔が空けば数え直す', async () => {
    const { port, closes, clock } = setup();
    for (let sequence = 1; sequence <= 20; sequence += 1) port.deliver(frame(sequence, 'ready'));
    expect(closes).toEqual([]);
    clock.now += 1000;
    for (let sequence = 21; sequence <= 40; sequence += 1) port.deliver(frame(sequence, 'ready'));
    expect(closes).toEqual([]);
    port.deliver(frame(41, 'ready'));
    expect(closes).toEqual(['rate']);
  });

  it('別の表示（古いinstance）のframeと、順番の違反は、通信を終える', () => {
    const old = setup();
    old.port.deliver({ ...frame(1, 'ready'), instanceId: 'instance-0' });
    expect(old.closes).toEqual(['instance']);
    const reordered = setup();
    reordered.port.deliver(frame(5, 'ready'));
    reordered.port.deliver(frame(5, 'ready'));
    expect(reordered.closes).toEqual(['sequence']);
  });

  it('終えた後のframeは処理しない', async () => {
    const { port, host, calls } = setup();
    host.close('replaced');
    port.deliver(frame(1, 'ready'));
    await flush();
    expect(calls).toEqual([]);
  });
});

describe('FB-011 別の画面による回答案の変更の通知', () => {
  it('自分のupdateDraftで作った版は知らせず、ほかの変更だけを、古い版へ戻さずに知らせる', async () => {
    const { port, host, release } = setup();
    port.deliver(frame(1, 'ready'));
    await flush();
    // readyで受け取った版（2）以下は知らせない。
    host.notifyDraft({ answers: { layout: 'A' }, draftVersion: 2 });
    host.notifyDraft({ answers: { layout: 'B' }, draftVersion: 3 });
    // 自分の保存の応答を待っている間の通知は、応答の後に、自分の版でなければ知らせる。
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

  it('上限を超える応答は送らず、失敗として返す', async () => {
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
