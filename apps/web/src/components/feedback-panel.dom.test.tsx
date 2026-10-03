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
// Wait for screen updates and effects to settle.
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// Wait past the delay between typing stopping and the draft being saved (300ms). Used to check that no save happens.
const afterSaveDelay = () => settle(400);
// Wait until the condition holds. Under the load of tests running in parallel, timers and screen updates are delayed.
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(10);
}
// Wait until save has been called count times.
const saved = (count: number) => until(() => saves.length >= count);

// The element with the given role inside the label whose text matches.
function control(text: string, role: 'radio' | 'checkbox'): HTMLElement {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const found = label?.querySelector<HTMLElement>(`[role="${role}"]`);
  if (!found) throw new Error(`${role} for "${text}" not found`);
  return found;
}
const isChecked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';
// In happy-dom, a Base UI checkbox does not toggle when its visual element is clicked. Click the input inside the label instead.
function toggle(text: string): void {
  const input = control(text, 'checkbox').parentElement?.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input for "${text}" not found`);
  input.click();
}
const statusText = () =>
  container.querySelector('[data-testid="feedback-status"]')?.textContent ?? '';
const summary = () => [...container.querySelectorAll('dd')].map((item) => item.textContent);
function sendButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Send answers to the agent',
  );
  if (!found) throw new Error('Submit button not found');
  return found;
}

describe('saving and showing the draft answer', () => {
  it('even if the save response arrives before the refetch, the input does not revert to the old draft', async () => {
    show(requestOf());
    await until(() => statusText() !== '');
    control('A', 'radio').click();
    await saved(1);
    expect(saves).toMatchObject([{ expected: 0, answers: { layout: 'A' } }]);

    // The save succeeded. No refetch yet, so the shown question is still at version 0.
    saves[0]?.resolve(1);
    await until(() => statusText() === 'Draft answer saved');
    expect(isChecked(control('A', 'radio'))).toBe(true);
    expect(summary()[0]).toBe('A');
    expect(statusText()).toBe('Draft answer saved');

    // The late refetch result (this panel's own save) does not change the view.
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await settle();
    expect(isChecked(control('A', 'radio'))).toBe(true);

    // The next input is saved based on the saved version.
    control('B', 'radio').click();
    await saved(2);
    expect(saves[1]).toMatchObject({ expected: 1, answers: { layout: 'B' } });
  });

  it('input made during a save stays unsaved and is then saved based on the saved version', async () => {
    show(requestOf());
    await until(() => statusText() !== '');
    control('A', 'radio').click();
    await saved(1);
    control('B', 'radio').click();
    // The refetch arrives before the save response.
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await settle();
    saves[0]?.resolve(1);
    await until(() => statusText() === 'Unsaved changes');
    expect(isChecked(control('B', 'radio'))).toBe(true);
    expect(statusText()).toBe('Unsaved changes');
    await saved(2);
    expect(saves[1]).toMatchObject({ expected: 1, answers: { layout: 'B' } });
  });

  it('shows a draft updated by another window when there is no unsaved input', async () => {
    show(requestOf());
    await until(() => statusText() !== '');
    show(requestOf({ draftVersion: 3, draftAnswers: { layout: 'B' } }));
    await until(() => statusText() === 'Draft answer saved');
    expect(isChecked(control('B', 'radio'))).toBe(true);
    expect(statusText()).toBe('Draft answer saved');
    // The next save is based on the shown version.
    control('A', 'radio').click();
    await saved(1);
    expect(saves).toMatchObject([{ expected: 3, answers: { layout: 'A' } }]);
  });
});

describe('submission from another window', () => {
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

  it("does not show this panel's unsaved input as the submitted answers", async () => {
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await until(() => statusText() !== '');
    // Before the save, another window submitted the saved answers (A).
    control('B', 'radio').click();
    show(submittedA(1));
    await afterSaveDelay();
    expect(saves).toEqual([]);
    expect(isChecked(control('A', 'radio'))).toBe(true);
    expect(summary()[0]).toBe('A');
    expect(statusText()).toBe('Submitted. Waiting for the agent to retrieve it');
  });

  it('shows the submitted answers even if another window submits during a save and the save then fails', async () => {
    show(requestOf({ draftVersion: 1, draftAnswers: { layout: 'A' } }));
    await until(() => statusText() !== '');
    control('B', 'radio').click();
    await saved(1);
    expect(saves).toMatchObject([{ expected: 1, answers: { layout: 'B' } }]);
    show(submittedA(1));
    await settle();
    saves[0]?.reject(
      new ApiError('E_REQUEST_NOT_PENDING', 'The question is not awaiting an answer.', 409, {}),
    );
    await settle();
    expect(isChecked(control('A', 'radio'))).toBe(true);
    expect(summary()[0]).toBe('A');
    expect(statusText()).toBe('Submitted. Waiting for the agent to retrieve it');
  });
});

describe('FB-016 confirming an answer to an older revision', () => {
  it('the confirmation is valid only for the revision it was made for; if the revision changes again, confirm again and send the confirmed revision', async () => {
    const draft = { draftVersion: 1, draftAnswers: { layout: 'A' } };
    show(requestOf({ ...draft, currentRevision: REV2 }));
    await until(() => statusText() !== '');
    const confirmation = 'I confirm that this answer is for the older revision';
    expect(sendButton().disabled).toBe(true);
    toggle(confirmation);
    await until(() => !sendButton().disabled);
    expect(sendButton().disabled).toBe(false);

    // After confirming, the document was updated again.
    show(requestOf({ ...draft, currentRevision: REV3 }));
    await until(() => sendButton().disabled);
    expect(isChecked(control(confirmation, 'checkbox'))).toBe(false);
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain('Confirm again');

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

describe('empty answers (spec 11.2)', () => {
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

  it('a required field that allows an empty value can be answered with an explicit empty answer, distinct from not answered', async () => {
    show(requestOf({ questionnaire: emptyAllowed }));
    await until(() => statusText() !== '');
    // Only required fields that allow an empty value have the empty-answer control.
    expect(
      [...container.querySelectorAll('[data-testid$="-empty"]')].map((item) =>
        item.getAttribute('data-testid'),
      ),
    ).toEqual(['feedback-note-empty', 'feedback-tags-empty']);
    expect(sendButton().disabled).toBe(true);

    toggle('Answer with an empty value');
    toggle('Answer with none selected');
    // The empty-string option can be chosen as an option distinct from "not selected".
    const select = container.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Select an option',
      '(empty)',
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
    expect(summary()).toEqual(['(empty)', '(none selected)', 'Not answered', '(empty)']);
    expect(sendButton().disabled).toBe(false);
  });
});
