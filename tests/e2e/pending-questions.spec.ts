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
  documentId: string;
}

const questionnaire = (title: string) => ({
  schemaVersion: 1,
  title,
  fieldOrder: ['verdict'],
  answerSchema: {
    type: 'object',
    properties: { verdict: { type: 'string', title: '判定', enum: ['OK', 'NG'] } },
    required: ['verdict'],
    additionalProperties: false,
  },
});

// Ask a question about a newly opened document.
async function ask(file: string, title: string): Promise<Request> {
  t.write(`${file}.json`, JSON.stringify(questionnaire(title)));
  t.write(file, `# ${file}\n\n本文\n`);
  const { request } = await t.json<{ request: Request }>(['ask', `${file}.json`, '--view', file]);
  return request;
}

const waiting = (page: Page) => page.getByRole('region', { name: /^Waiting for your answer/ });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Open documents' });
const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Answer the question' });

test('lists the questions of every document, shows the pressed one, and drops each once answered or cancelled', async ({
  page,
}) => {
  const first = await ask('layout.md', 'レイアウトの選択');
  const second = await ask('wording.md', '文言の確認');
  t.write('notes.md', '# notes\n');
  await t.json(['open', 'notes.md']);
  await page.goto(await t.uiUrl());

  const list = waiting(page);
  await expect(list.getByRole('heading')).toHaveText('Waiting for your answer (2)');
  // Oldest first, named by the question and described by its document.
  const rows = list.getByRole('button');
  await expect(rows).toHaveText([/^レイアウトの選択/, /^文言の確認/]);
  await expect(rows.nth(1)).toHaveAccessibleName('文言の確認');
  await expect(rows.nth(1)).toHaveAccessibleDescription(/^wording\.md\. .*wording\.md\. Asked /);
  // Each document keeps its own badge.
  await expect(sidebar(page).getByTestId('pending-question')).toHaveCount(2);

  await rows.nth(1).click();
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name: '文言の確認' })).toBeVisible();
  await expect(
    sidebar(page).locator(`button[data-document-id="${second.documentId}"]`),
  ).toHaveAttribute('aria-current', 'true');

  await panel.getByRole('radio', { name: 'OK', exact: true }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  await panel.getByRole('button', { name: 'Send answers to the agent' }).click();
  await expect(list.getByRole('heading')).toHaveText('Waiting for your answer (1)');
  await expect(rows).toHaveText([/^レイアウトの選択/]);

  await t.json(['feedback', 'cancel', first.requestId]);
  await expect(list).toHaveCount(0);
});
