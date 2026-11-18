import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;
test.beforeEach(() => {
  t = createE2eHome();
});
test.afterEach(async () => {
  await t.cleanup();
});

interface Status {
  uiUrl: string;
  daemonId: string;
}

// Save the ports the first start got into listeners.json, as a user does once, and restart onto them.
async function fixPorts(): Promise<Status> {
  const first = await t.json<Status>(['daemon', 'status']);
  const response = await fetch(`${first.uiUrl}_/api/v1/status`);
  const { previewOrigin } = ((await response.json()) as { data: { previewOrigin: string } }).data;
  writeFileSync(
    join(t.home, 'listeners.json'),
    JSON.stringify({
      managementPort: Number(new URL(first.uiUrl).port),
      previewPort: Number(new URL(previewOrigin).port),
    }),
  );
  return t.json<Status>(['daemon', 'restart']);
}

const frameOf = (page: Page) => page.frameLocator('[data-testid="document-frame"]');
const frameSrc = (page: Page) => page.getByTestId('document-frame').getAttribute('src');

test('PC restart: the same tab shows the open HTML again, as Static, from the same URL', async ({
  page,
}) => {
  t.write(
    'demo.html',
    `<!doctype html><html><head><title>デモ</title></head><body><p id="count">0</p>
<button id="plus" type="button">増やす</button>
<script>document.getElementById('plus').addEventListener('click', () => {
  const count = document.getElementById('count'); count.textContent = String(Number(count.textContent) + 1);
});</script></body></html>`,
  );
  await t.json(['open', 'demo.html', '--no-open', '--html-mode', 'interactive']);
  const before = await fixPorts();
  const { documents } = await t.json<{ documents: Array<{ documentId: string }> }>(['list']);
  const documentId = documents[0]?.documentId ?? '';
  await page.goto(`${before.uiUrl}?document=${documentId}`);
  // Restarting onto the saved ports dropped the permission. Allow scripts again from the PC.
  await expect(page.getByTestId('html-mode')).toHaveText('Scripts off');
  await t.json(['open', 'demo.html', '--no-open', '--html-mode', 'interactive']);
  await expect(page.getByTestId('html-mode')).toHaveText('Scripts running');
  await frameOf(page).getByRole('button', { name: '増やす' }).click();
  await expect(frameOf(page).locator('#count')).toHaveText('1');
  const interactiveSrc = await frameSrc(page);

  // Another document opened meanwhile does not recreate the demo.
  t.write('other.md', '# other\n');
  await t.json(['open', 'other.md', '--no-open']);
  await expect(
    page
      .getByRole('navigation', { name: 'Open documents' })
      .getByRole('button', { name: 'other', exact: true }),
  ).toBeVisible();
  await expect(frameOf(page).locator('#count')).toHaveText('1');
  expect(await frameSrc(page)).toBe(interactiveSrc);

  const after = await t.json<Status>(['daemon', 'restart']);
  expect(after.uiUrl).toBe(before.uiUrl);
  expect(after.daemonId).not.toBe(before.daemonId);
  // The tab reconnects by itself and shows the same document from the new daemon, with scripts off.
  await expect(page.getByTestId('html-mode')).toHaveText('Scripts off', { timeout: 15_000 });
  await expect(frameOf(page).locator('#count')).toHaveText('0');
  await expect.poll(() => frameSrc(page)).not.toBe(interactiveSrc);
  expect(new URL(page.url()).searchParams.get('document')).toBe(documentId);
  // The old view URL is gone with the old daemon.
  expect((await fetch(interactiveSrc ?? '')).status).toBe(404);
  await page.screenshot({ path: test.info().outputPath('pc-restart.png') });
});

test('PC restart: Markdown images and a standalone image come back in their open tabs', async ({
  page,
  context,
}) => {
  const png = readFileSync(new URL('../fixtures/images/sample.png', import.meta.url));
  t.write('pic.png', png);
  t.write('note.md', '# 画像つき\n\n![図](pic.png)\n');
  await t.json(['open', 'note.md', 'pic.png', '--no-open']);
  const before = await fixPorts();
  const { documents } = await t.json<{
    documents: Array<{ documentId: string; title: string }>;
  }>(['list']);
  const idOf = (title: string) =>
    documents.find((document) => document.title === title)?.documentId ?? '';

  const imageTab = await context.newPage();
  await page.goto(`${before.uiUrl}?document=${idOf('note.md')}`);
  await imageTab.goto(`${before.uiUrl}?document=${idOf('pic.png')}`);
  // The src of the image once it has loaded, other than `previous`.
  const loadedSrc = async (target: Page, name: string, previous = '') => {
    let src = '';
    await expect
      .poll(
        async () => {
          src = await target
            .getByRole('img', { name, exact: true })
            .evaluate((img: HTMLImageElement) =>
              img.complete && img.naturalWidth > 0 ? img.src : '',
            );
          return src !== '' && src !== previous;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return src;
  };
  const markdownBefore = await loadedSrc(page, '図');
  const imageBefore = await loadedSrc(imageTab, 'pic.png');

  await t.json(['daemon', 'restart']);
  // From the moment the new daemon is ready, both tabs fetch new grants and load their images again, within the
  // 15-second budget for the automatic recovery.
  const ready = Date.now();
  await Promise.all([
    loadedSrc(page, '図', markdownBefore),
    loadedSrc(imageTab, 'pic.png', imageBefore),
  ]);
  expect(Date.now() - ready).toBeLessThan(15_000);
  await page.screenshot({ path: test.info().outputPath('pc-images.png') });
});

test('PC restart: a question HTML drops its answer port, and re-allowing on the PC links the same question again', async ({
  page,
}) => {
  t.write(
    'q.json',
    JSON.stringify({
      schemaVersion: 1,
      title: '再起動の確認',
      fieldOrder: ['choice'],
      answerSchema: {
        type: 'object',
        properties: { choice: { type: 'string', title: '選択', enum: ['A', 'B'] } },
        required: ['choice'],
        additionalProperties: false,
      },
    }),
  );
  t.write(
    'review.html',
    `<!doctype html><html><head><title>質問</title></head><body><p id="state">waiting</p><script>
vde.ready().then((info) => { document.getElementById('state').textContent = 'ready ' + info.questionnaire.title; });
</script></body></html>`,
  );
  const { request } = await t.json<{ request: { requestId: string; revision: string } }>([
    'ask',
    'q.json',
    '--view',
    'review.html',
    '--html-mode',
    'interactive',
  ]);
  const before = await fixPorts();
  const allow = () => t.json(['open', 'review.html', '--no-open', '--html-mode', 'interactive']);
  await allow();
  await page.goto(before.uiUrl);
  await expect(frameOf(page).locator('#state')).toHaveText('ready 再起動の確認');
  await expect(page.getByTestId('bridge-status')).toBeVisible();

  await t.json(['daemon', 'restart']);
  // The new daemon has no script permission: the question is shown without scripts and without the answer port.
  await expect(frameOf(page).locator('#state')).toHaveText('waiting', { timeout: 15_000 });
  await expect(page.getByTestId('bridge-status')).toHaveCount(0);
  await allow();
  await expect(frameOf(page).locator('#state')).toHaveText('ready 再起動の確認');
  const after = await t.json<{ requestId: string; status: string; revision: string }>([
    'feedback',
    'get',
    request.requestId,
  ]);
  expect(after).toMatchObject({ status: 'pending', revision: request.revision });
  await page.screenshot({ path: test.info().outputPath('pc-question.png') });
});
