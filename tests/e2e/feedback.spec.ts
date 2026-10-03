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

const panelOf = (page: Page) => page.getByRole('complementary', { name: '質問への回答' });

test('FB-001: 質問をnative formで表示し、必須の選択肢を初期選択せず、本体の送信で確定する', async ({
  page,
}) => {
  t.write('q.json', JSON.stringify(sample));
  const { request } = await t.json<{ request: Request }>(['ask', 'q.json']);
  await page.goto(await t.bootstrapUrl());
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name: 'ログイン画面の確認' })).toBeVisible();
  // 一覧でも、回答待ちの質問がある文書が分かる。
  await expect(
    page.getByRole('navigation', { name: '開いている文書' }).getByTestId('pending-question'),
  ).toHaveText('回答待ち');
  await expect(panel).toContainText('採用案と表示密度を選んでください。');
  // enumはradio。どれも選ばれていない。必須の印がある。
  const radios = panel.getByRole('radio');
  await expect(radios).toHaveCount(4);
  for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
  await expect(panel.getByText('（必須）')).toHaveCount(2);
  const send = panel.getByRole('button', { name: 'Agentへ回答を送信' });
  await expect(send).toBeDisabled();
  await expect(panel.getByTestId('feedback-status')).toHaveText('未回答');

  await panel.getByRole('radio', { name: 'B', exact: true }).click();
  await panel.getByRole('radio', { name: 'compact', exact: true }).click();
  await panel.getByRole('textbox').fill('説明を短く');
  await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  // 回答の要約は、送信buttonの横に常に出る。
  const summary = panel.getByRole('definition');
  await expect(summary).toHaveText(['B', 'compact', '説明を短く']);
  // Agentには、送信まで回答を返さない。
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    '送信しました。Agentの取得を待っています',
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
  await expect(panel.getByTestId('feedback-status')).toHaveText('Agentが回答を取得しました');
});

test('FB-015の前提: 回答待ちの間は質問の版を表示し続け、新しい版では旧版への回答の確認を求める。Enterでは送信しない', async ({
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
  await expect(panel.getByRole('alert')).toContainText('新しい版があります');
  // 入力中の表示は、新しい版へ差し替えない。
  await expect(article).toContainText('最初の本文');
  await expect(article).not.toContainText('新しい本文');

  await panel.getByRole('radio', { name: 'OK', exact: true }).click();
  const note = panel.getByRole('textbox');
  await note.fill('確認しました');
  await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  const send = panel.getByRole('button', { name: 'Agentへ回答を送信' });
  // 旧版への回答であることを確認するまで、送信できない。
  await expect(send).toBeDisabled();
  await panel
    .getByRole('checkbox', { name: '旧版への回答として送信することを確認しました' })
    .click();
  await expect(send).toBeEnabled();
  // 入力欄でのEnterは、送信にならない。
  await note.press('Enter');
  await page.waitForTimeout(500);
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    '送信しました。Agentの取得を待っています',
  );
  const answered = await t.json<Request>(['feedback', 'get', request.requestId]);
  expect(answered.submission).toMatchObject({
    answers: { verdict: 'OK', note: '確認しました' },
    confirmedAgainstOlderRevision: true,
  });
  // 回答が確定したら、表示は現在の版へ戻る。
  await expect(article).toContainText('新しい本文');
});

test('質問を管理UIから中止すると、Agentはcancelledとして受け取る', async ({ page }) => {
  t.write('q.json', JSON.stringify(sample));
  const { request } = await t.json<{ request: Request }>(['ask', 'q.json']);
  await page.goto(await t.bootstrapUrl());
  const panel = panelOf(page);
  await panel.getByRole('button', { name: '中止' }).click();
  await page.getByRole('button', { name: '中止する' }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('中止されました');
  const waited = await t.json<Request & { cancellation: { reason: string } }>([
    'feedback',
    'wait',
    request.requestId,
    '--timeout',
    '5',
  ]);
  expect(waited).toMatchObject({ status: 'cancelled', cancellation: { reason: 'user_cancelled' } });
});
