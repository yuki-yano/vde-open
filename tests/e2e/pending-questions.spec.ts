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

test('shows the same list in the Tree layout and in the drawer of a narrow screen', async ({
  page,
}) => {
  await ask('layout.md', 'レイアウトの選択');
  await ask('wording.md', '文言の確認');
  await page.goto(await t.uiUrl());
  await sidebar(page).getByRole('button', { name: 'Tree' }).click();
  await expect(sidebar(page).getByRole('tree')).toBeVisible();
  await expect(waiting(page).getByRole('button')).toHaveText([/^レイアウトの選択/, /^文言の確認/]);

  await page.setViewportSize({ width: 800, height: 700 });
  const toggle = page.getByRole('button', { name: 'Document list' });
  await toggle.click();
  await waiting(page).getByRole('button', { name: 'レイアウトの選択' }).click();
  // Choosing a question closes the drawer, like choosing a document.
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar(page)).toBeHidden();
  await expect(panelOf(page).getByRole('heading', { name: 'レイアウトの選択' })).toBeVisible();
});

test('a long list keeps to its share of the sidebar and scrolls on its own', async ({ page }) => {
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await ask(`${name}.md`, `質問 ${name}`);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(await t.uiUrl());
  const list = waiting(page);
  await expect(list.getByRole('heading')).toHaveText('Waiting for your answer (6)');
  const nav = await sidebar(page).boundingBox();
  const region = await list.boundingBox();
  expect(region!.height).toBeLessThanOrEqual(nav!.height * 0.5 + 1);
  const scroller = list.getByRole('list');
  expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  // Scrolling the questions leaves their heading and the document list where they are.
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(list.getByRole('button', { name: '質問 f' })).toBeInViewport();
  await expect(list.getByRole('heading')).toBeInViewport();
  await expect(sidebar(page).getByRole('heading', { name: 'Open documents (6)' })).toBeInViewport();
});

test('keyboard focus moves to the next question when the focused one goes away, then to its document', async ({
  page,
}) => {
  const first = await ask('layout.md', 'レイアウトの選択');
  const second = await ask('wording.md', '文言の確認');
  await page.goto(await t.uiUrl());
  const rows = waiting(page).getByRole('button');
  await expect(rows).toHaveCount(2);
  await rows.first().focus();

  await t.json(['feedback', 'cancel', first.requestId]);
  await expect(rows).toHaveCount(1);
  await expect(waiting(page).getByRole('button', { name: '文言の確認' })).toBeFocused();

  await t.json(['feedback', 'cancel', second.requestId]);
  await expect(waiting(page)).toHaveCount(0);
  await expect(
    sidebar(page).locator(`button[data-document-id="${second.documentId}"]`),
  ).toBeFocused();
});

const answered = (page: Page) =>
  page.getByRole('region', { name: /^Answered, agent has not picked up/ });

// Answer a question the way the answer panel does, through the management API from the page.
async function answerFromPage(page: Page, requestId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`/_/api/v1/feedback/${id}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await response.json()) as { ok: boolean; data: T };
      if (!body.ok) throw new Error(`${path} failed: ${JSON.stringify(body)}`);
      return body.data;
    };
    const question = await call<{
      draftVersion: number;
      revision: string;
      currentRevision: string | null;
    }>('');
    const { draftVersion } = await call<{ draftVersion: number }>('/draft', {
      method: 'PUT',
      body: JSON.stringify({
        expectedDraftVersion: question.draftVersion,
        answers: { verdict: 'OK' },
      }),
    });
    await call('/submit', {
      method: 'POST',
      body: JSON.stringify({
        submissionId: `sub_${crypto.randomUUID()}`,
        expectedDraftVersion: draftVersion,
        revision: question.revision,
        currentRevision: question.currentRevision,
      }),
    });
  }, requestId);
}

test('an answer the agent has not picked up shows below the questions, in both layouts and the drawer, until the agent acknowledges it', async ({
  page,
}) => {
  await ask('layout.md', 'レイアウトの選択');
  const second = await ask('wording.md', '文言の確認');
  await page.goto(await t.uiUrl());
  await expect(waiting(page).getByRole('button')).toHaveCount(2);
  await expect(answered(page)).toHaveCount(0);

  await waiting(page).getByRole('button', { name: '文言の確認' }).click();
  const panel = panelOf(page);
  await panel.getByRole('radio', { name: 'OK', exact: true }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  await panel.getByRole('button', { name: 'Send answers to the agent' }).click();
  await expect(waiting(page).getByRole('heading')).toHaveText('Waiting for your answer (1)');
  await expect(answered(page).getByRole('heading')).toHaveText(
    'Answered, agent has not picked up (1)',
  );
  const row = answered(page).getByRole('button');
  await expect(row).toHaveAccessibleName('文言の確認');
  await expect(row).toHaveAccessibleDescription(
    /^wording\.md\. .*wording\.md\. Answered just now\.$/,
  );
  await expect(row.locator('[data-part="elapsed"]')).toHaveText('answered just now');

  // Pressing the answer shows its document.
  const documentRow = sidebar(page).locator(`button[data-document-id="${second.documentId}"]`);
  await waiting(page).getByRole('button', { name: 'レイアウトの選択' }).click();
  await expect(documentRow).not.toHaveAttribute('aria-current', 'true');
  await row.click();
  await expect(documentRow).toHaveAttribute('aria-current', 'true');

  await sidebar(page).getByRole('button', { name: 'Tree' }).click();
  await expect(sidebar(page).getByRole('tree')).toBeVisible();
  await expect(answered(page).getByRole('button')).toHaveText([/^文言の確認/]);

  await page.setViewportSize({ width: 800, height: 700 });
  const toggle = page.getByRole('button', { name: 'Document list' });
  await toggle.click();
  await answered(page).getByRole('button', { name: '文言の確認' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(answered(page).getByRole('button')).toHaveCount(1);

  const { submission } = await t.json<{ submission: { submissionId: string } }>([
    'feedback',
    'get',
    second.requestId,
  ]);
  await t.json(['feedback', 'ack', second.requestId, '--submission-id', submission.submissionId]);
  await expect(answered(page)).toHaveCount(0);
  await expect(waiting(page).getByRole('button')).toHaveText([/^レイアウトの選択/]);
});

test('the two lists share their room above the document list: a short one keeps its rows whole, and each scrolls on its own', async ({
  page,
}) => {
  const requests: Request[] = [];
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    requests.push(await ask(`${name}.md`, `質問 ${name}`));
  }
  // Tall enough that a section with one row fits in half of the room.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(await t.uiUrl());
  const nav = (await sidebar(page).boundingBox())!;
  const heights = async () =>
    (await waiting(page).boundingBox())!.height + (await answered(page).boundingBox())!.height;
  const overflows = (region: ReturnType<typeof waiting>) =>
    region.getByRole('list').evaluate((element) => element.scrollHeight > element.clientHeight);

  await answerFromPage(page, requests[7]!.requestId);
  await expect(answered(page).getByRole('heading')).toHaveText(
    'Answered, agent has not picked up (1)',
  );
  await expect(waiting(page).getByRole('heading')).toHaveText('Waiting for your answer (7)');
  expect(await heights()).toBeLessThanOrEqual(nav.height * 0.5 + 1);
  expect(await overflows(waiting(page))).toBe(true);
  expect(await overflows(answered(page))).toBe(false);

  for (const request of requests.slice(4, 7)) await answerFromPage(page, request.requestId);
  await expect(answered(page).getByRole('heading')).toHaveText(
    'Answered, agent has not picked up (4)',
  );
  await expect(waiting(page).getByRole('heading')).toHaveText('Waiting for your answer (4)');
  expect(await heights()).toBeLessThanOrEqual(nav.height * 0.5 + 1);
  expect(await overflows(waiting(page))).toBe(true);
  expect(await overflows(answered(page))).toBe(true);

  // Scrolling the answers leaves the questions, both headings and the document list where they are.
  const scroller = answered(page).getByRole('list');
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  // Oldest answer first, so the last answered is at the bottom.
  await expect(answered(page).getByRole('button')).toHaveText([
    /^質問 h/,
    /^質問 e/,
    /^質問 f/,
    /^質問 g/,
  ]);
  await expect(answered(page).getByRole('button', { name: '質問 g' })).toBeInViewport();
  expect(
    await waiting(page)
      .getByRole('list')
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await expect(waiting(page).getByRole('heading')).toBeInViewport();
  await expect(answered(page).getByRole('heading')).toBeInViewport();
  await expect(sidebar(page).getByRole('heading', { name: 'Open documents (8)' })).toBeInViewport();
});
