import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

interface Request {
  requestId: string;
  revision: string;
  status: string;
  submission: null | {
    submissionId: string;
    answers: Record<string, unknown>;
    confirmedAgainstOlderRevision: boolean;
  };
  acknowledgedAt: string | null;
}

const sample = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  instructions: '採用案と表示密度を選んでください。',
  fieldOrder: ['layout', 'density', 'comment'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      density: { type: 'string', title: '表示密度', enum: ['comfortable', 'compact'] },
      comment: { type: 'string', title: '修正したい点', maxLength: 4000 },
    },
    required: ['layout', 'density'],
    additionalProperties: false,
  },
};

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Answer the question' });

test('FB-001: shows the question as a native form, does not preselect required options, and finalizes with the UI submit', async ({
  page,
}) => {
  t.write('q.json', JSON.stringify(sample));
  const { request } = await t.json<{ request: Request }>(['ask', 'q.json']);
  await page.goto(await t.bootstrapUrl());
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name: 'ログイン画面の確認' })).toBeVisible();
  // The list also shows which document has a question awaiting an answer.
  await expect(
    page.getByRole('navigation', { name: 'Open documents' }).getByTestId('pending-question'),
  ).toHaveText('Question');
  await expect(panel).toContainText('採用案と表示密度を選んでください。');
  // enum fields are radios. None is selected. Required fields are marked.
  const radios = panel.getByRole('radio');
  await expect(radios).toHaveCount(4);
  for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
  await expect(panel.getByText('(required)')).toHaveCount(2);
  const send = panel.getByRole('button', { name: 'Send answers to the agent' });
  await expect(send).toBeDisabled();
  await expect(panel.getByTestId('feedback-status')).toHaveText('Not answered');

  await panel.getByRole('radio', { name: 'B', exact: true }).click();
  await panel.getByRole('radio', { name: 'compact', exact: true }).click();
  await panel.getByRole('textbox').fill('説明を短く');
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  // The answer summary is always shown next to the submit button.
  const summary = panel.getByRole('definition');
  await expect(summary).toHaveText(['B', 'compact', '説明を短く']);
  // Nothing is returned to the agent until submitted.
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    'Submitted. Waiting for the agent to retrieve it',
  );
  await expect(page.getByTestId('pending-question')).toHaveCount(0);
  const answered = await t.json<Request>(['feedback', 'get', request.requestId]);
  expect(answered.submission?.answers).toEqual({
    layout: 'B',
    density: 'compact',
    comment: '説明を短く',
  });
  await t.json([
    'feedback',
    'ack',
    request.requestId,
    '--submission-id',
    answered.submission?.submissionId as string,
  ]);
  await expect(panel.getByTestId('feedback-status')).toHaveText('The agent retrieved the answers');
});

test("FB-015 prerequisite: while awaiting an answer, the question's revision stays shown; a newer revision asks for older-revision confirmation; Enter does not submit", async ({
  page,
}) => {
  const question = {
    schemaVersion: 1,
    title: '本文の確認',
    fieldOrder: ['verdict', 'note'],
    answerSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', title: '判定', enum: ['OK', 'NG'] },
        note: { type: 'string', title: 'メモ', maxLength: 50 },
      },
      required: ['verdict'],
      additionalProperties: false,
    },
  };
  t.write('q.json', JSON.stringify(question));
  t.write('a.md', '# 版1\n\n最初の本文\n');
  const { request } = await t.json<{ request: Request }>(['ask', 'q.json', '--view', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  const panel = panelOf(page);
  const article = page.locator('article');
  await expect(article).toContainText('最初の本文');

  t.atomicWrite('a.md', '# 版2\n\n新しい本文\n');
  await expect(panel.getByRole('alert')).toContainText('A newer revision is available');
  // The view being answered is not replaced with the new revision.
  await expect(article).toContainText('最初の本文');
  await expect(article).not.toContainText('新しい本文');

  await panel.getByRole('radio', { name: 'OK', exact: true }).click();
  const note = panel.getByRole('textbox');
  await note.fill('確認しました');
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  const send = panel.getByRole('button', { name: 'Send answers to the agent' });
  // Cannot submit until the answer to the older revision is confirmed.
  await expect(send).toBeDisabled();
  await panel
    .getByRole('checkbox', { name: 'I confirm that this answer is for the older revision' })
    .click();
  await expect(send).toBeEnabled();
  // Enter in a text field does not submit.
  await note.press('Enter');
  await page.waitForTimeout(500);
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    'Submitted. Waiting for the agent to retrieve it',
  );
  const answered = await t.json<Request>(['feedback', 'get', request.requestId]);
  expect(answered.submission).toMatchObject({
    answers: { verdict: 'OK', note: '確認しました' },
    confirmedAgainstOlderRevision: true,
  });
  // Once the answer is finalized, the view returns to the current revision.
  await expect(article).toContainText('新しい本文');
});

test('cancelling a question from the management UI reaches the agent as cancelled', async ({
  page,
}) => {
  t.write('q.json', JSON.stringify(sample));
  const { request } = await t.json<{ request: Request }>(['ask', 'q.json']);
  await page.goto(await t.bootstrapUrl());
  const panel = panelOf(page);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel question' }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('Cancelled');
  const waited = await t.json<Request & { cancellation: { reason: string } }>([
    'feedback',
    'wait',
    request.requestId,
    '--timeout',
    '5',
  ]);
  expect(waited).toMatchObject({ status: 'cancelled', cancellation: { reason: 'user_cancelled' } });
});
