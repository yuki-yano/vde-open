import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;
test.beforeEach(() => {
  t = createE2eHome();
});
test.afterEach(async () => {
  await t.cleanup();
});

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Open documents' });
const rows = (page: Page) => sidebar(page).locator('button[data-document-id]');

async function openList(page: Page, names = ['Alpha', 'Beta', 'Gamma']) {
  names.forEach((name) => t.write(`${name}.md`, `# ${name}\n`));
  await t.json(['open', ...names.map((name) => `${name}.md`)]);
  await page.goto(await t.bootstrapUrl());
  await expect(rows(page)).toHaveCount(names.length);
}

async function pickUp(page: Page, title: string) {
  const handle = sidebar(page).getByRole('button', { name: title, exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
  await expect(sidebar(page).getByTestId('drop-position')).toBeVisible();
}

test('drag previews the exact insertion position, saves on drop, and has no move buttons', async ({
  page,
}) => {
  await openList(page);
  await expect(sidebar(page).getByTestId('drag-card')).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: /^Reorder / })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: /Move .* (up|down)/ })).toHaveCount(0);
  const destination = (await rows(page).nth(2).boundingBox())!;
  await pickUp(page, 'Alpha');
  await expect(page.getByTestId('drag-card')).toBeVisible();
  await page.mouse.move(destination.x + 40, destination.y + destination.height / 2, { steps: 12 });
  await expect(rows(page)).toHaveText([/Beta/, /Gamma/, /Alpha/]);
  // The placeholder moves with the proposed order, before anything is saved.
  await expect(
    sidebar(page).getByRole('listitem').last().getByTestId('drop-position'),
  ).toBeVisible();
  expect(
    (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
      (item) => item.title,
    ),
  ).toEqual(['Alpha', 'Beta', 'Gamma']);
  await page.mouse.up();
  await expect(sidebar(page).getByTestId('drop-position')).toHaveCount(0);
  await expect(page.getByTestId('drag-card')).toHaveCount(0);
  await expect
    .poll(async () =>
      (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
        (item) => item.title,
      ),
    )
    .toEqual(['Beta', 'Gamma', 'Alpha']);
  await page.reload();
  await expect(rows(page)).toHaveText([/Beta/, /Gamma/, /Alpha/]);
});

test('Escape restores the original order and a document click still selects without dragging', async ({
  page,
}) => {
  await openList(page);
  await rows(page).nth(1).click();
  await expect(page.getByRole('region', { name: 'Document view' }).locator('header h1')).toHaveText(
    'Beta',
  );
  const destination = (await rows(page).nth(2).boundingBox())!;
  await pickUp(page, 'Alpha');
  await page.mouse.move(destination.x + 40, destination.y + destination.height / 2, { steps: 12 });
  await expect(rows(page)).toHaveText([/Beta/, /Gamma/, /Alpha/]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(rows(page)).toHaveText([/Alpha/, /Beta/, /Gamma/]);
  expect(
    (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
      (item) => item.title,
    ),
  ).toEqual(['Alpha', 'Beta', 'Gamma']);
});

for (const part of ['title', 'location']) {
  test(`dragging from the ${part} reorders without selecting the document`, async ({ page }) => {
    await openList(page);
    const shown = page.getByRole('region', { name: 'Document view' }).locator('header h1');
    await expect(shown).toHaveText('Alpha');
    const source = rows(page).nth(1);
    const start = (await source.locator(`[data-part="${part}"]`).boundingBox())!;
    const target = (await rows(page).nth(2).boundingBox())!;
    await page.mouse.move(start.x + 10, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 22, start.y + start.height / 2);
    await expect(sidebar(page).getByTestId('drop-position')).toBeVisible();
    await page.mouse.move(target.x + 60, target.y + target.height / 2, { steps: 10 });
    await expect(rows(page)).toHaveText([/Alpha/, /Gamma/, /Beta/]);
    await page.mouse.up();
    await expect(sidebar(page).getByTestId('drop-position')).toHaveCount(0);
    await expect(shown).toHaveText('Alpha');
    await expect
      .poll(async () =>
        (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
          (item) => item.title,
        ),
      )
      .toEqual(['Alpha', 'Gamma', 'Beta']);
  });
}

test('a small pointer movement still selects, and the remove button cannot start a drag', async ({
  page,
}) => {
  await openList(page);
  const beta = (await rows(page).nth(1).boundingBox())!;
  await page.mouse.move(beta.x + 60, beta.y + 15);
  await page.mouse.down();
  await page.mouse.move(beta.x + 63, beta.y + 15);
  await page.mouse.up();
  await expect(page.getByRole('region', { name: 'Document view' }).locator('header h1')).toHaveText(
    'Beta',
  );
  await expect(sidebar(page).getByTestId('drop-position')).toHaveCount(0);
  const remove = sidebar(page).getByRole('button', {
    name: 'Remove Beta from the list',
    exact: true,
  });
  const box = (await remove.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 8 });
  await expect(sidebar(page).getByTestId('drop-position')).toHaveCount(0);
  await page.mouse.up();
  await expect(rows(page)).toHaveCount(3);
  await rows(page).nth(1).hover();
  await remove.click();
  await expect(rows(page)).toHaveText([/Alpha/, /Gamma/]);
});

test('dragging near the bottom scrolls the list to reach an offscreen position', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await openList(
    page,
    Array.from({ length: 30 }, (_, index) => `Item ${String(index).padStart(2, '0')}`),
  );
  const scrolling = sidebar(page).locator('.overflow-y-auto');
  const box = (await scrolling.boundingBox())!;
  await pickUp(page, 'Item 00');
  await page.mouse.move(box.x + 35, box.y + box.height - 8, { steps: 10 });
  await expect.poll(() => scrolling.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await t.json<{ documents: { title: string }[] }>(['list'])).documents.findIndex(
        (item) => item.title === 'Item 00',
      ),
    )
    .toBeGreaterThan(3);
});

test('the document row also sorts with Space and arrow keys', async ({ page }) => {
  await openList(page);
  const handle = sidebar(page).getByRole('button', { name: 'Alpha', exact: true });
  await handle.focus();
  await handle.press('Space');
  await handle.press('ArrowDown');
  await expect(rows(page)).toHaveText([/Beta/, /Alpha/, /Gamma/]);
  await handle.press('Space');
  await expect
    .poll(async () =>
      (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
        (item) => item.title,
      ),
    )
    .toEqual(['Beta', 'Alpha', 'Gamma']);
  await expect(handle).toBeFocused();
});

test('a catalog change during a drag cancels that reorder without dropping the new document', async ({
  page,
}) => {
  await openList(page);
  const destination = (await rows(page).nth(2).boundingBox())!;
  await pickUp(page, 'Alpha');
  await page.mouse.move(destination.x + 40, destination.y + destination.height / 2, { steps: 12 });
  await expect(rows(page)).toHaveText([/Beta/, /Gamma/, /Alpha/]);
  t.write('Delta.md', '# Delta\n');
  await t.json(['open', 'Delta.md']);
  await expect(sidebar(page).getByRole('heading')).toHaveText('Open documents (4)');
  await page.mouse.up();
  await expect(rows(page)).toHaveText([/Alpha/, /Beta/, /Gamma/, /Delta/]);
  await sidebar(page).getByRole('button', { name: 'Order not changed' }).click();
  await expect(page.getByRole('dialog')).toContainText('list changed while dragging');
  expect(
    (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
      (item) => item.title,
    ),
  ).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
});

test.describe('touch drag', () => {
  test.use({ hasTouch: true });
  for (const part of ['title', 'location']) {
    test(`holding the ${part} allows a touch drag without a document click`, async ({
      page,
      browserName,
      context,
    }) => {
      test.skip(
        browserName !== 'chromium',
        'Touch gestures are sent through the Chromium device protocol.',
      );
      await openList(page);
      const handle = (await rows(page).first().locator(`[data-part="${part}"]`).boundingBox())!;
      const destination = (await rows(page).nth(2).boundingBox())!;
      const touch = await context.newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }],
      });
      await expect(sidebar(page).getByTestId('drop-position')).toBeVisible();
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: destination.x + 40, y: destination.y + destination.height / 2 }],
      });
      await expect(rows(page)).toHaveText([/Beta/, /Gamma/, /Alpha/]);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect
        .poll(async () =>
          (await t.json<{ documents: { title: string }[] }>(['list'])).documents.map(
            (item) => item.title,
          ),
        )
        .toEqual(['Beta', 'Gamma', 'Alpha']);
    });
  }

  test('swiping a row before the hold scrolls the list without starting a drag', async ({
    page,
    browserName,
    context,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Touch gestures are sent through the Chromium device protocol.',
    );
    await page.setViewportSize({ width: 1280, height: 420 });
    await openList(
      page,
      Array.from({ length: 30 }, (_, index) => `Item ${String(index).padStart(2, '0')}`),
    );
    const row = (await rows(page).nth(3).boundingBox())!;
    const x = row.x + 80;
    const y = row.y + row.height / 2;
    const touch = await context.newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const offset of [20, 40, 70, 100]) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - offset }],
      });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect
      .poll(() =>
        sidebar(page)
          .locator('.overflow-y-auto')
          .evaluate((el) => el.scrollTop),
      )
      .toBeGreaterThan(20);
    await expect(sidebar(page).getByTestId('drop-position')).toHaveCount(0);
    expect((await t.json<{ documents: { title: string }[] }>(['list'])).documents[0]?.title).toBe(
      'Item 00',
    );
  });
});
