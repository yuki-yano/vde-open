// @vitest-environment happy-dom
import type { Answers, FeedbackForUi, FeedbackSubmitParams, Questionnaire } from '@vde-open/shared';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiError, type Api } from '@/lib/api';

import { FeedbackPanel } from './feedback-panel.tsx';

const REV1 = `rev_${'1'.repeat(64)}`;
const REV2 = `rev_${'2'.repeat(64)}`;
const REV3 = `rev_${'3'.repeat(64)}`;
const T0 = '2026-10-03T00:00:00.000Z';

const questionnaire: Questionnaire = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  fieldOrder: ['layout', 'density'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      density: { type: 'string', title: '表示密度', enum: ['comfortable', 'compact'] },
    },
    required: ['layout'],
    additionalProperties: false,
  },
};

function requestOf(overrides: Partial<FeedbackForUi> = {}): FeedbackForUi {
  return {
    requestId: `req_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
    documentId: 'doc_1',
    revision: REV1,
    title: questionnaire.title,
    status: 'pending',
    createdAt: T0,
    submission: null,
    cancellation: null,
    acknowledgedAt: null,
    questionnaire,
    renderMode: 'static',
    draftVersion: 0,
    draftAnswers: {},
    currentRevision: REV1,
    documentOpen: true,
    ...overrides,
  };
}

interface Save {
  expected: number;
  answers: Answers;
  resolve: (draftVersion: number) => void;
  reject: (error: Error) => void;
}

let container: HTMLElement;
let root: Root;
let saves: Save[];
let submits: FeedbackSubmitParams[];
let api: Api;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  saves = [];
  submits = [];
  api = {
    saveDraft: (_requestId: string, expected: number, answers: Answers) =>
      new Promise<{ draftVersion: number }>((resolve, reject) => {
        saves.push({
          expected,
          answers,
          resolve: (draftVersion) => resolve({ draftVersion }),
          reject,
        });
      }),
    submitFeedback: (_requestId: string, params: FeedbackSubmitParams) => {
      submits.push(params);
      return Promise.resolve(requestOf({ status: 'submitted' }));
    },
    cancelFeedback: () => Promise.resolve(),
  } as unknown as Api;
});

afterEach(() => {
  root.unmount();
  container.remove();
});

const show = (request: FeedbackForUi) =>
  root.render(<FeedbackPanel api={api} request={request} reload={() => undefined} />);
// 画面の更新とeffectが落ち着くまで待つ。
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// 入力が止まってから回答案を保存するまで（300ms）を待つ。保存しないことを確かめるときに使う。
const afterSaveDelay = () => settle(400);
// 条件が成り立つまで待つ。testを並行して動かす負荷の下では、timerと画面の更新が遅れる。
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(10);
}
// 保存がcount回まで呼ばれるのを待つ。
const saved = (count: number) => until(() => saves.length >= count);

// 文字が一致するlabelの中の、指定したroleの要素。
function control(text: string, role: 'radio' | 'checkbox'): HTMLElement {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const found = label?.querySelector<HTMLElement>(`[role="${role}"]`);
  if (!found) throw new Error(`${text} の${role}が見つかりません`);
  return found;
}
const isChecked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';
// Base UIのcheckboxは、happy-domでは表示用の要素のclickで切り替わらない。labelの中のinputを押す。
function toggle(text: string): void {
  const input = control(text, 'checkbox').parentElement?.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`${text} のinputが見つかりません`);
  input.click();
}
const statusText = () =>
  container.querySelector('[data-testid="feedback-status"]')?.textContent ?? '';
const summary = () => [...container.querySelectorAll('dd')].map((item) => item.textContent);
function sendButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Agentへ回答を送信',
  );
  if (!found) throw new Error('送信buttonが見つかりません');
  return found;
}

describe('回答案の保存と表示', () => {
  it('保存の応答が再取得より先に届いても、入力は古い回答案へ戻らない', async () => {
    show(requestOf());
    await until(() => statusText() !== '');
    control('A', 'radio').click();
    await saved(1);
    expect(saves).toMatchObject([{ expected: 0, answers: { layout: 'A' } }]);

    // 保存が成功した。まだ再取得していないので、表示中の質問は版0のまま。
    saves[0]?.resolve(1);
    await until(() => statusText() === '回答案を保存しました');
    expect(isChecked(control('A', 'radio'))).toBe(true);
    expect(summary()[0]).toBe('A');
    expect(statusText()).toBe('回答案を保存しました');

    // 遅れて届いた再取得の結果（自分の保存）では、表示を変えない。
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await settle();
    expect(isChecked(control('A', 'radio'))).toBe(true);

    // 次の入力は、保存した版をもとに保存する。
    control('B', 'radio').click();
    await saved(2);
    expect(saves[1]).toMatchObject({ expected: 1, answers: { layout: 'B' } });
  });

  it('保存の途中の入力は未保存のまま残し、保存した版をもとに続けて保存する', async () => {
    show(requestOf());
    await until(() => statusText() !== '');
    control('A', 'radio').click();
    await saved(1);
    control('B', 'radio').click();
    // 再取得が保存の応答より先に届く。
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await settle();
    saves[0]?.resolve(1);
    await until(() => statusText() === '未保存の入力があります');
    expect(isChecked(control('B', 'radio'))).toBe(true);
    expect(statusText()).toBe('未保存の入力があります');
    await saved(2);
    expect(saves[1]).toMatchObject({ expected: 1, answers: { layout: 'B' } });
  });

  it('別の画面が更新した回答案は、未保存の入力がなければ表示する', async () => {
    show(requestOf());
    await until(() => statusText() !== '');
    show(requestOf({ draftVersion: 3, draftAnswers: { layout: 'B' } }));
    await until(() => statusText() === '回答案を保存しました');
    expect(isChecked(control('B', 'radio'))).toBe(true);
    expect(statusText()).toBe('回答案を保存しました');
    // 次の保存は、表示した版をもとにする。
    control('A', 'radio').click();
    await saved(1);
    expect(saves).toMatchObject([{ expected: 3, answers: { layout: 'A' } }]);
  });
});

describe('別の画面での確定', () => {
  const submittedA = (draftVersion: number) =>
    requestOf({
      status: 'submitted',
      draftVersion,
      draftAnswers: { layout: 'A' },
      submission: {
        submissionId: `sub_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
        answers: { layout: 'A' },
        submittedAt: T0,
        revision: REV1,
        confirmedAgainstOlderRevision: false,
        currentRevisionAtSubmit: REV1,
      },
    } as Partial<FeedbackForUi>);

  it('この画面の未保存の入力を、確定した回答として表示しない', async () => {
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await until(() => statusText() !== '');
    // 保存の前に、別の画面が保存済みの回答（A）を確定した。
    control('B', 'radio').click();
    show(submittedA(1));
    await afterSaveDelay();
    expect(saves).toEqual([]);
    expect(isChecked(control('A', 'radio'))).toBe(true);
    expect(summary()[0]).toBe('A');
    expect(statusText()).toBe('送信しました。Agentの取得を待っています');
  });

  it('保存の途中で別の画面が確定し、その後に保存の失敗が届いても、確定した回答を表示する', async () => {
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await until(() => statusText() !== '');
    control('B', 'radio').click();
    await saved(1);
    expect(saves).toMatchObject([{ expected: 1, answers: { layout: 'B' } }]);
    show(submittedA(1));
    await settle();
    saves[0]?.reject(
      new ApiError('E_REQUEST_NOT_PENDING', '質問は回答待ちではありません。', 409, {}),
    );
    await settle();
    expect(isChecked(control('A', 'radio'))).toBe(true);
    expect(summary()[0]).toBe('A');
    expect(statusText()).toBe('送信しました。Agentの取得を待っています');
  });
});

describe('FB-016 旧版への回答の確認', () => {
  it('確認は、確認したときの版にだけ有効。版がさらに変われば確認し直し、確認した版を送る', async () => {
    const draft = { draftVersion: 1, draftAnswers: { layout: 'A' } };
    show(requestOf({ ...draft, currentRevision: REV2 }));
    await until(() => statusText() !== '');
    const confirmation = '旧版への回答として送信することを確認しました';
    expect(sendButton().disabled).toBe(true);
    toggle(confirmation);
    await until(() => !sendButton().disabled);
    expect(sendButton().disabled).toBe(false);

    // 確認した後に、文書がさらに更新された。
    show(requestOf({ ...draft, currentRevision: REV3 }));
    await until(() => sendButton().disabled);
    expect(isChecked(control(confirmation, 'checkbox'))).toBe(false);
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain('もう一度確認してください');

    toggle(confirmation);
    await until(() => !sendButton().disabled);
    sendButton().click();
    await until(() => submits.length > 0);
    expect(submits).toMatchObject([
      {
        revision: REV1,
        currentRevision: REV3,
        confirmOlderRevision: true,
        expectedDraftVersion: 1,
      },
    ]);
  });
});

describe('空の回答（仕様11.2）', () => {
  const emptyAllowed: Questionnaire = {
    schemaVersion: 1,
    title: '空の回答',
    fieldOrder: ['note', 'tags', 'strict', 'pick'],
    answerSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', title: 'メモ', maxLength: 100 },
        tags: {
          type: 'array',
          title: '分類',
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string', enum: ['x', 'y'] },
        },
        strict: { type: 'string', title: '理由', minLength: 1, maxLength: 100 },
        pick: { type: 'string', title: '選択', enum: ['', 'a', 'b', 'c', 'd', 'e', 'f'] },
      },
      required: ['note', 'tags', 'pick'],
      additionalProperties: false,
    },
  };

  it('必須でも空が有効なfieldは、空の回答を明示して送れる。未入力とは区別する', async () => {
    show(requestOf({ questionnaire: emptyAllowed }));
    await until(() => statusText() !== '');
    // 空が有効な必須のfieldにだけ、空の回答の欄がある。
    expect(
      [...container.querySelectorAll('[data-testid$="-empty"]')].map((item) =>
        item.getAttribute('data-testid'),
      ),
    ).toEqual(['feedback-note-empty', 'feedback-tags-empty']);
    expect(sendButton().disabled).toBe(true);

    toggle('空欄のまま回答する');
    toggle('どれも選ばずに回答する');
    // 選択肢の空の文字列は、未選択とは別の選択肢として選べる。
    const select = container.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '選択してください',
      '（空欄）',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
    select.value = '0';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await saved(1);
    expect(saves).toMatchObject([{ expected: 0, answers: { note: '', tags: [], pick: '' } }]);
    saves[0]?.resolve(1);
    await until(() => !sendButton().disabled);
    expect(summary()).toEqual(['（空欄）', '（選択なし）', '未回答', '（空欄）']);
    expect(sendButton().disabled).toBe(false);
  });
});
