import { realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { gitDir, worktree } from '../../apps/cli/src/documents/git.fixture.ts';
import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Open documents' });
const rowOf = (page: Page, title: string) =>
  sidebarOf(page)
    .locator('li', { has: page.getByRole('button', { name: title }) })
    .first();

// Whether an element shows all of its text (nothing cut off with an ellipsis).
const whole = (element: Locator) =>
  element.evaluate((node) => node.scrollWidth <= node.clientWidth && node.clientWidth > 0);

const box = async (element: Locator) => {
  const found = await element.boundingBox();
  if (!found) throw new Error('The element is not shown.');
  return found;
};

const questionnaire = {
  schemaVersion: 1,
  title: '確認',
  fieldOrder: ['ok'],
  answerSchema: {
    type: 'object',
    properties: { ok: { type: 'string', title: 'OK', enum: ['yes', 'no'] } },
    required: ['ok'],
    additionalProperties: false,
  },
};

test('DOC-017: each document shows its repository, worktree, path, and format, in the list, the tree, and the header', async ({
  page,
}) => {
  const work = realpathSync(t.work);
  const repo = join(work, 'vde-open');
  gitDir(join(repo, '.git'));
  worktree(join(repo, '.git'), join(repo, '.git', 'wt', 'feature', 'x'), 'x', {
    head: 'ref: refs/heads/feature/x\n',
  });
  t.write('vde-open/docs/design.md', '# Design\n');
  t.write('vde-open/.git/wt/feature/x/docs/plan.md', '# Plan\n');
  t.write('notes/c.md', '# Notes\n');
  t.write('vde-open/view.html', '<title>View</title><p>v</p>');
  await t.json([
    'open',
    'vde-open/docs/design.md',
    'vde-open/.git/wt/feature/x/docs/plan.md',
    'notes/c.md',
    'vde-open/view.html',
  ]);
  await page.goto(await t.bootstrapUrl());
  const sidebar = sidebarOf(page);

  const location = (title: string) => rowOf(page, title).locator('[data-part="location"]');
  await expect(location('Design')).toHaveText(/^vde-open\s*docs\/design\.md$/);
  await expect(location('Plan')).toHaveText(/^vde-open\s*feature\/x\s*docs\/plan\.md$/);
  await expect(location('Notes')).toHaveText('…/notes/c.md');
  await expect(location('View')).toHaveText(/^vde-open\s*view\.html$/);

  // Markdown is blue and HTML orange (Catppuccin Latte blue, and the darker orange used for light).
  const color = (title: string) =>
    rowOf(page, title)
      .locator('svg[data-format]')
      .evaluate((icon) => getComputedStyle(icon).color);
  await page.getByRole('button', { name: 'Light' }).click();
  expect(await color('Design')).toBe('rgb(30, 102, 245)');
  expect(await color('View')).toBe('rgb(196, 74, 0)');

  await sidebar.getByRole('button', { name: 'Tree' }).click();
  const tree = sidebar.getByRole('tree');
  await expect(tree.getByRole('treeitem', { name: 'vde-open', exact: true })).toBeVisible();
  await expect(
    tree.getByRole('treeitem', { name: 'Worktree feature/x', exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole('treeitem', { name: 'Outside a repository', exact: true }),
  ).toBeVisible();

  await tree.getByRole('button', { name: 'plan.md', exact: true }).click();
  const shownLocation = page.locator('[data-testid="document-location"]:visible');
  await expect(shownLocation).toHaveText(/^vde-open\s+worktree feature\/x \(x\) · docs\/plan\.md/);
  await expect(shownLocation).toHaveAttribute(
    'title',
    join(repo, '.git', 'wt', 'feature', 'x', 'docs', 'plan.md'),
  );
});

for (const layout of [
  { name: '180px', width: 180 },
  { name: '260px', width: 260 },
  { name: 'the drawer', width: null },
]) {
  test(`DOC-017: at ${layout.name}, the repository name and the extension stay whole, and badges stay visible with the buttons`, async ({
    page,
  }) => {
    const work = realpathSync(t.work);
    const repo = join(work, 'repository');
    gitDir(join(repo, '.git'));
    const branch = 'feature/a-very-long-branch-name-for-xx';
    const checkout = join(work, 'wt');
    worktree(join(repo, '.git'), checkout, 'wt', { head: `ref: refs/heads/${branch}\n` });
    t.write('wt/first.md', '# First\n');
    t.write('wt/docs/a/b/overview1.md', '# Overview\n');
    t.write('wt/last.md', '# Last\n');
    t.write('q.json', JSON.stringify(questionnaire));
    await t.json(['open', 'wt/first.md', 'wt/docs/a/b/overview1.md', 'wt/last.md']);
    await t.json(['ask', 'q.json', '--view', 'wt/docs/a/b/overview1.md']);
    unlinkSync(join(checkout, 'docs', 'a', 'b', 'overview1.md'));

    if (layout.width === null) {
      await page.setViewportSize({ width: 375, height: 700 });
    } else {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.addInitScript(
        (width) =>
          window.localStorage.setItem('vde-open.pref.sidebar-width', JSON.stringify(width)),
        layout.width,
      );
    }
    await page.goto(await t.bootstrapUrl());
    if (layout.width === null) {
      await page.getByRole('button', { name: 'Document list' }).click();
    }
    const row = rowOf(page, 'Overview');
    await expect(row.getByTestId('pending-question')).toBeVisible();
    await expect(row.getByText('File missing')).toHaveCount(1, { timeout: 10_000 });
    expect(branch.length).toBe(38);

    const check = async (focused: boolean) => {
      if (focused) {
        // With keyboard focus, the whole location shows (wrapped) instead of the shortened line.
        await expect(row.locator('[data-part="location"]')).toBeHidden();
        await expect(row.locator('[data-part="location-full"]')).toBeVisible();
      } else {
        expect(await whole(row.locator('[data-part="repository-name"]'))).toBe(true);
        expect(await whole(row.locator('[data-part="extension"]'))).toBe(true);
      }
      const title = await box(row.locator('[data-part="title"]'));
      expect(title.width).toBeGreaterThanOrEqual(48);
      // The badges are inside the row and left of every button shown.
      const rowBox = await box(row);
      const badges = await Promise.all(
        [row.getByTestId('pending-question'), row.locator('[title="File missing"]')].map(box),
      );
      const buttons = await Promise.all(
        (await row.locator(':scope > span > button:visible').all()).map(box),
      );
      for (const badge of badges) {
        expect(badge.width).toBeGreaterThan(0);
        expect(badge.x + badge.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
        for (const button of buttons) expect(badge.x + badge.width).toBeLessThanOrEqual(button.x);
      }
    };

    await row.hover();
    await check(false);
    // With keyboard focus, the whole location shows instead. Reached with the keyboard so it is :focus-visible.
    await row.locator('button[data-document-id]').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(row.locator('button[data-document-id]')).toBeFocused();
    await page.mouse.move(0, 0);
    await check(true);
    await expect(row.locator('[data-part="location-full"]')).toContainText('docs/a/b/overview1.md');
  });
}

test('DOC-017: in the tree, the repository row stays on top, and focus and scrolling survive list updates', async ({
  page,
}) => {
  const work = realpathSync(t.work);
  const repo = join(work, 'app');
  gitDir(join(repo, '.git'));
  worktree(join(repo, '.git'), join(work, 'wt'), 'wt');
  const names = Array.from({ length: 40 }, (_, index) => `d${String(index).padStart(2, '0')}.md`);
  for (const name of names) t.write(`wt/docs/${name}`, `# ${name}\n`);
  await t.json(['open', ...names.map((name) => `wt/docs/${name}`)]);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(await t.bootstrapUrl());
  const sidebar = sidebarOf(page);
  await sidebar.getByRole('button', { name: 'Tree' }).click();
  const tree = sidebar.getByRole('tree');
  const list = sidebar.locator('div.overflow-y-auto');

  // One worktree only: the repository row shows it.
  const repositoryRow = tree.locator('[data-node="repository"] > div').first();
  await expect(repositoryRow).toHaveText(/app\s*wt/);

  // Scrolled into the middle, the repository row is still at the top of the list.
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight / 2;
  });
  const top = (await box(list)).y;
  await expect.poll(async () => Math.round((await box(repositoryRow)).y - top)).toBeLessThan(12);

  // Moving focus up with Shift+Tab never puts the focused row under the sticky row.
  const middle = tree.getByRole('button', { name: 'd20.md', exact: true });
  await middle.focus();
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Shift+Tab');
    const focused = page.locator(':focus');
    const focusedBox = await box(focused);
    const stickyBox = await box(repositoryRow);
    expect(focusedBox.y).toBeGreaterThanOrEqual(stickyBox.y + stickyBox.height - 1);
  }

  // A main checkout document splits the row into two levels. The focused document keeps focus.
  const focusedRow = tree.getByRole('button', { name: 'd18.md', exact: true });
  await focusedRow.focus();
  t.write('app/readme.md', '# readme\n');
  await t.json(['open', 'app/readme.md']);
  await expect(tree.getByRole('button', { name: 'readme.md', exact: true })).toBeVisible();
  await expect(tree.locator('[data-node="worktree"] > div').first()).not.toHaveClass(/sr-only/);
  await expect(focusedRow).toBeFocused();

  // Scrolled away from the focused row, an update does not pull the list back.
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  const before = await list.evaluate((node) => node.scrollTop);
  t.atomicWrite('wt/docs/d00.md', '# d00 changed\n');
  await expect(tree.getByRole('button', { name: 'd00.md', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await list.evaluate((node) => node.scrollTop)).toBe(before);
  await expect(focusedRow).toBeFocused();
});

test('DOC-017: on a touch screen, tapping a badge does not remove the document', async ({
  browser,
}) => {
  const work = realpathSync(t.work);
  gitDir(join(work, 'repo', '.git'));
  t.write('repo/a.md', '# Alpha\n');
  t.write('repo/b.md', '# Beta\n');
  t.write('q.json', JSON.stringify(questionnaire));
  await t.json(['open', 'repo/a.md', 'repo/b.md']);
  await t.json([
    'ask',
    'q.json',
    '--document',
    (await t.json<{ documents: Array<{ documentId: string; title: string }> }>(['list']))
      .documents[1]?.documentId as string,
  ]);
  const context = await browser.newContext({
    viewport: { width: 375, height: 700 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(await t.bootstrapUrl());
    await page.getByRole('button', { name: 'Document list' }).tap();
    const row = rowOf(page, 'Beta');
    const badge = row.getByTestId('pending-question');
    await expect(badge).toBeVisible();
    // Without hover, the buttons always show, beside the badges rather than over them.
    await expect(row.getByRole('button', { name: 'Remove Beta from the list' })).toHaveCSS(
      'opacity',
      '1',
    );
    // A tap on the badge selects the document (and closes the drawer); it is not removed.
    await badge.tap();
    await expect(
      page
        .getByRole('region', { name: 'Document view' })
        .locator('header')
        .getByRole('heading', { name: 'Beta' }),
    ).toBeVisible();
    const listed = await t.json<{ documents: unknown[] }>(['list']);
    expect(listed.documents).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test('DOC-017: at 180px only the remove button shows, and Alt+Up/Down reorders and keeps focus', async ({
  page,
}) => {
  const work = realpathSync(t.work);
  gitDir(join(work, 'repo', '.git'));
  for (const name of ['One', 'Two', 'Three']) t.write(`repo/${name}.md`, `# ${name}\n`);
  await t.json(['open', 'repo/One.md', 'repo/Two.md', 'repo/Three.md']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() =>
    window.localStorage.setItem('vde-open.pref.sidebar-width', JSON.stringify(180)),
  );
  await page.goto(await t.bootstrapUrl());
  const sidebar = sidebarOf(page);
  const middle = rowOf(page, 'Two');
  await middle.hover();
  await expect(middle.locator(':scope > span > button:visible')).toHaveCount(1);

  const button = middle.locator('button[data-document-id]');
  await button.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(sidebar.getByRole('listitem')).toHaveText([/Two/, /One/, /Three/]);
  await expect(button).toBeFocused();
  // At the top, Alt+Up does nothing.
  await page.keyboard.press('Alt+ArrowUp');
  await expect(sidebar.getByRole('listitem')).toHaveText([/Two/, /One/, /Three/]);
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(sidebar.getByRole('listitem')).toHaveText([/One/, /Three/, /Two/]);
  await expect(button).toBeFocused();
  // The order is saved to the daemon after the list moves.
  await expect
    .poll(async () =>
      (await t.json<{ documents: Array<{ title: string }> }>(['list'])).documents.map(
        (document) => document.title,
      ),
    )
    .toEqual(['One', 'Three', 'Two']);
});

test('DOC-017: opening again a document removed with its button does not take focus or scroll', async ({
  page,
}) => {
  const work = realpathSync(t.work);
  gitDir(join(work, 'repo', '.git'));
  const names = Array.from({ length: 40 }, (_, index) => `d${String(index).padStart(2, '0')}.md`);
  for (const name of names) t.write(`repo/${name}`, `# ${name}\n`);
  await t.json(['open', ...names.map((name) => `repo/${name}`)]);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(await t.bootstrapUrl());
  const sidebar = sidebarOf(page);
  const list = sidebar.locator('div.overflow-y-auto');
  const row = rowOf(page, 'd02.md');
  await row.hover();
  await row.getByRole('button', { name: 'Remove d02.md from the list' }).click();
  await expect(sidebar.getByRole('button', { name: 'd02.md', exact: true })).toHaveCount(0);
  await page.getByRole('region', { name: 'Document view' }).click();
  const before = await list.evaluate((node) => node.scrollTop);

  await t.json(['open', 'repo/d02.md']);
  await expect(sidebar.getByRole('button', { name: 'd02.md', exact: true })).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await list.evaluate((node) => node.scrollTop)).toBe(before);
  expect(await page.evaluate(() => document.activeElement?.closest('nav') === null)).toBe(true);
});

for (const view of ['flat', 'tree'] as const) {
  test(`DOC-017: in the ${view} view, a focused document that becomes resolved keeps focus and is not pulled back when scrolled away`, async ({
    page,
  }) => {
    const work = realpathSync(t.work);
    gitDir(join(work, 'repo', '.git'));
    const names = Array.from({ length: 40 }, (_, index) => `d${String(index).padStart(2, '0')}.md`);
    for (const name of names) t.write(`repo/${name}`, `# ${name}\n`);
    const opened = await t.json<{ documents: Array<{ documentId: string; title: string }> }>([
      'open',
      ...names.map((name) => `repo/${name}`),
    ]);
    const target = opened.documents.find((document) => document.title === 'd30.md')?.documentId;
    // The list shows the target as pending until told otherwise (the daemon resolves it at once).
    let pending = true;
    await page.route(
      (url) => url.pathname.endsWith('/documents'),
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          data: { documents: Array<{ documentId: string; repository: unknown }> };
        };
        if (pending) {
          for (const document of body.data.documents) {
            if (document.documentId === target) document.repository = { state: 'pending' };
          }
        }
        await route.fulfill({ response, json: body });
      },
    );
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.addInitScript(
      (layout) => window.localStorage.setItem('vde-open.pref.sidebar-view', JSON.stringify(layout)),
      view,
    );
    await page.goto(await t.bootstrapUrl());
    const sidebar = sidebarOf(page);
    const list = sidebar.locator('div.overflow-y-auto');
    const row = sidebar.locator(`[data-document-id="${String(target)}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.focus();
    if (view === 'tree') {
      await expect(
        sidebar.getByRole('treeitem', { name: 'Checking repositories', exact: true }),
      ).toBeVisible();
    }

    // Scrolled away from the focused row: an update does not pull the list back.
    await list.evaluate((node) => {
      node.scrollTop = 0;
    });
    pending = false;
    t.atomicWrite('repo/d00.md', '# d00.md\n\nchanged\n');
    if (view === 'tree') {
      await expect(
        sidebar.getByRole('treeitem', { name: 'Checking repositories', exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(
        sidebar.locator(`li:has([data-document-id="${String(target)}"]) [data-part="repository"]`),
      ).toHaveText('repo');
    }
    await page.waitForTimeout(300);
    expect(await list.evaluate((node) => node.scrollTop)).toBe(0);
    await expect(sidebar.locator(`[data-document-id="${String(target)}"]`)).toBeFocused();
  });
}

// A touch screen on a machine with a mouse: (hover: hover) stays true, and a tap hovers the row just before its click.
// Headless Chromium has no coarse pointer, so the buttons appear on that hover; the click must still not press them.
test('DOC-017: a tap on a screen with hover does not press a button revealed under the finger', async ({
  page,
}) => {
  const work = realpathSync(t.work);
  gitDir(join(work, 'repo', '.git'));
  for (const name of ['Alpha', 'Beta', 'Gamma']) t.write(`repo/${name}.md`, `# ${name}\n`);
  t.write('q.json', JSON.stringify(questionnaire));
  await t.json(['open', 'repo/Alpha.md', 'repo/Beta.md', 'repo/Gamma.md']);
  await t.json(['ask', 'q.json', '--view', 'repo/Beta.md']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(await t.bootstrapUrl());
  const row = rowOf(page, 'Beta');
  const cdp = await page.context().newCDPSession(page);
  const tap = async (x: number, y: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  // On the badge, and on the right end of the title, where the buttons appear.
  const points = [
    {
      target: row.getByTestId('pending-question'),
      at: (found: { width: number }) => found.width / 2,
    },
    {
      target: row.locator('[data-part="title"]'),
      at: (found: { width: number }) => found.width - 4,
    },
  ];
  for (const { target, at } of points) {
    await page.mouse.move(0, 0);
    const found = await box(target);
    await tap(found.x + at(found), found.y + found.height / 2);
    await page.waitForTimeout(300);
  }

  const listed = await t.json<{ documents: Array<{ title: string }> }>(['list']);
  expect(listed.documents.map((document) => document.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  const questions = await t.json<{ requests: Array<{ status: string }> }>(['feedback', 'list']);
  expect(questions.requests.map((request) => request.status)).toEqual(['pending']);
});
