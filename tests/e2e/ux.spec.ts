import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

let t: E2eHome;

test.beforeEach(() => {
  t = createE2eHome();
});

test.afterEach(async () => {
  await t.cleanup();
});

const questionnaire = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  fieldOrder: ['layout', 'comment'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      comment: { type: 'string', title: '修正したい点', maxLength: 4000 },
    },
    required: ['layout'],
    additionalProperties: false,
  },
};

// 表示中の文書のtitle（viewerの見出し。本文のh1より前にある）。
const heading = (page: Page) =>
  page.getByRole('region', { name: '文書の表示' }).getByRole('heading', { level: 1 }).first();

test('UX-002: Cmd/Ctrl+Kで検索を開き、開いている文書だけを探して移動する。Escapeで閉じるとfocusが戻る', async ({
  page,
}) => {
  t.write('alpha.md', '# 認証の設計\n\nsessionの期限は12時間。\n');
  t.write('beta.md', '# 検索の設計\n\n## 日本語の分割\n\n形態素ではなくIntl.Segmenterで分ける。\n');
  t.write('closed.md', '# 閉じた文書\n\nIntl.Segmenterの説明。\n');
  await t.json(['open', 'alpha.md', 'beta.md', 'closed.md']);
  await t.json(['close', 'closed.md']);
  await page.goto(await t.bootstrapUrl());
  await expect(heading(page)).toHaveText('認証の設計');

  const opener = page.getByRole('button', { name: /開いている文書を検索/ });
  await opener.focus();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: '開いている文書を検索する' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('検索の対象は、いま開いている文書だけです');
  const input = dialog.getByRole('textbox', { name: '検索する語句' });
  await expect(input).toBeFocused();
  await input.fill('Segmenter');
  const results = dialog.getByRole('option');
  // 閉じた文書は探さない。
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('検索の設計');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(heading(page)).toHaveText('検索の設計');

  // Escapeで閉じると、開く前のfocusへ戻る。
  await opener.focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('UX-002: 検索の結果の節へ移動し、表示する版を読み込めない間は、前の版の節へ移動しない', async ({
  page,
}) => {
  const filler = Array.from({ length: 150 }, (_, index) => `前置きの行${String(index)}`).join(
    '\n\n',
  );
  t.write('a.md', `# 文書\n\n${filler}\n\n## Old heading\n\n古い本文\n`);
  await t.json(['open', 'a.md']);
  await page.goto(await t.bootstrapUrl());
  const oldHeading = page.getByRole('heading', { name: 'Old heading' });
  await expect(oldHeading).toBeAttached();
  await expect(oldHeading).not.toBeInViewport();

  const search = async (query: string) => {
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: '開いている文書を検索する' });
    await dialog.getByRole('textbox', { name: '検索する語句' }).fill(query);
    await expect(dialog.getByRole('option')).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
  };
  // 表示中の版の結果なら、その節へ移動する。
  await search('古い本文');
  await expect(oldHeading).toBeInViewport();
  await page
    .getByRole('region', { name: '文書の表示' })
    .getByText('前置きの行0', { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(oldHeading).not.toBeInViewport();

  // 新しい版の本文を取得できないようにしてから、文書を更新する。表示は前の版のまま。
  await page.route(/\/_\/api\/v1\/documents\/[^/]+\/content/, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'E_INTERNAL', message: '試験のための失敗' },
      }),
    }),
  );
  t.write('a.md', `# 文書\n\n${filler}\n\n## NewHit heading\n\n新しい本文\n`);
  await expect(page.getByText('試験のための失敗')).toBeVisible({ timeout: 10_000 });

  // 新しい版の結果を選んでも、前の版の同じ番号の節（Old heading）へは移動しない。
  await search('NewHit');
  await expect(page.getByTestId('section-target-notice')).toContainText(
    '表示する版を読み込めないため、節へ移動しません',
  );
  await expect(oldHeading).not.toBeInViewport();
});

test('UX-001 / UX-002: keyboardだけで、検索・文書の切替・質問への入力・送信ができ、入力中の文字は奪わない', async ({
  page,
}) => {
  t.write('q.json', JSON.stringify(questionnaire));
  t.write('other.md', '# 別の文書\n\n本文\n');
  await t.json(['open', 'other.md']);
  const { request } = await t.json<{ request: { requestId: string } }>([
    'ask',
    'q.json',
    '--view',
    'other.md',
  ]);
  await page.goto(await t.bootstrapUrl());
  const panel = page.getByRole('complementary', { name: '質問への回答' });
  await expect(panel.getByRole('heading', { name: 'ログイン画面の確認' })).toBeVisible();

  // 選択肢はradio groupの中で矢印keyとSpaceで選ぶ。
  const radio = panel.getByRole('radio', { name: 'A', exact: true });
  await radio.focus();
  await page.keyboard.press('Space');
  await expect(radio).toBeChecked();
  // 入力欄では、kやj、数字などの文字をそのまま入力できる（single-keyの操作に奪われない）。
  const comment = panel.getByRole('textbox', { name: '修正したい点' });
  await comment.focus();
  await page.keyboard.type('jk[]/ 123');
  await expect(comment).toHaveValue('jk[]/ 123');
  await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  // 送信buttonは、Tabで届き、Enterで押せる（入力欄でのEnterは送信にならない）。
  const send = panel.getByRole('button', { name: 'Agentへ回答を送信' });
  await send.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    '送信しました。Agentの取得を待っています',
  );
  expect((await t.json<{ status: string }>(['feedback', 'get', request.requestId])).status).toBe(
    'submitted',
  );

  // 一覧の文書は、buttonとしてkeyboardで選べる。一覧から外す操作にも名前がある。
  const list = page.getByRole('navigation', { name: '開いている文書' });
  await expect(list.getByRole('button', { name: /一覧から外す/ }).first()).toBeVisible();
});

test('UX-003: 狭い画面では一覧をdrawerにし、巨大なHTMLでも回答の送信buttonを覆わない', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  t.write('q.json', JSON.stringify(questionnaire));
  const tall = Array.from({ length: 3000 }, (_, index) => `<p>行${String(index)}</p>`).join('');
  t.write(
    'huge.html',
    `<!doctype html><html><body style="margin:0"><div style="position:fixed;inset:0;background:red;z-index:2147483647"></div>${tall}</body></html>`,
  );
  await t.json(['ask', 'q.json', '--view', 'huge.html']);
  await page.goto(await t.bootstrapUrl());
  // pageは横にはみ出さず、headerの操作（一覧、検索、配色）はすべて画面の中にある。
  await expect(page.getByRole('button', { name: 'ライト' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const name of [
    '文書の一覧',
    '開いている文書を検索',
    'ライト',
    'ダーク',
    'OSの設定に合わせる',
  ]) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box, name).not.toBeNull();
    if (box) expect(box.x + box.width, name).toBeLessThanOrEqual(375);
  }
  // 一覧は閉じたdrawer。buttonで開閉できる。
  const list = page.getByRole('navigation', { name: '開いている文書' });
  await expect(list).toBeHidden();
  await page.getByRole('button', { name: '文書の一覧' }).click();
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: '文書の一覧' }).click();
  await expect(list).toBeHidden();

  const panel = page.getByRole('complementary', { name: '質問への回答' });
  await panel.getByRole('radio', { name: 'B', exact: true }).click();
  const send = panel.getByRole('button', { name: 'Agentへ回答を送信' });
  await expect(send).toBeEnabled();
  // 送信buttonは、文書の表示（iframe）の外にあり、HTMLが覆えない。
  const frame = await page.getByTestId('document-frame').boundingBox();
  const button = await send.boundingBox();
  expect(frame).not.toBeNull();
  expect(button).not.toBeNull();
  if (frame && button) expect(button.y).toBeGreaterThanOrEqual(frame.y + frame.height);
  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    '送信しました。Agentの取得を待っています',
  );
});

test('UX-004: 配色などの表示の設定はbrowserに残し、開いている文書はdaemonの状態に従う', async ({
  page,
}) => {
  t.write('a.md', '# A\n');
  t.write('b.md', '# B\n');
  await t.json(['open', 'a.md', 'b.md']);
  await page.goto(await t.bootstrapUrl());
  await page.getByRole('button', { name: 'ダーク' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  // CLIで閉じた文書は、読み直した後の一覧に出ない。表示の設定は残る。
  await t.json(['close', 'b.md']);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const list = page.getByRole('navigation', { name: '開いている文書' });
  await expect(list).toContainText('A');
  await expect(list).not.toContainText('B');
});

test('UX-005: 表示できない部分は、対象・理由・対処を示し、許可を広げるbuttonはない', async ({
  page,
}) => {
  t.write(
    'page.html',
    '<h1>表示の確認</h1><img src="https://example.com/a.png"><script>alert(1)</script><img src="missing.png">',
  );
  await t.json(['open', 'page.html']);
  await page.goto(await t.bootstrapUrl());
  const diagnostics = page.getByTestId('render-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics).toContainText('https://example.com/a.png');
  await expect(diagnostics).toContainText('外部のURL');
  await expect(diagnostics).toContainText('相対pathで参照すると表示できます');
  await expect(diagnostics).toContainText('scriptを1件取り除きました');
  await expect(diagnostics).toContainText('missing.png');
  await expect(page.getByRole('button', { name: /すべて許可|全て許可|許可を広げ/ })).toHaveCount(0);
});

test('PERF-002: 1,000文書でも一覧に全件が出て、末尾の文書を選んで表示でき、保存が表示に反映される', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const COUNT = 1000;
  for (let index = 0; index < COUNT; index += 1) {
    const name = String(index).padStart(4, '0');
    t.write(`docs/doc-${name}.md`, `# 文書${name}\n\n本文${name}\n`);
  }
  await t.json(['open', 'docs', '--recursive']);
  await page.goto(await t.bootstrapUrl());
  const sidebar = page.getByRole('navigation', { name: '開いている文書' });
  await expect(
    sidebar.getByRole('heading', { name: `開いている文書（${String(COUNT)}）` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.locator('li')).toHaveCount(COUNT);

  // 末尾の文書を選ぶと、その文書を表示する。
  const last = sidebar.getByRole('button', { name: '文書0999', exact: true });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(heading(page)).toHaveText('文書0999');
  await expect(page.getByText('本文0999')).toBeVisible();

  // 保存すると、表示中の本文が新しい版に変わる。一覧の件数は変わらない。
  t.write('docs/doc-0999.md', '# 文書0999\n\n保存した後の本文\n');
  await expect(page.getByText('保存した後の本文')).toBeVisible({ timeout: 10_000 });
  await expect(sidebar.locator('li')).toHaveCount(COUNT);
});

test('コードと、文書のpath・IDをcopyできる（仕様13.2）', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // copyするのは、表示しているcode（閉じのfenceの前の改行は含まない）。
  const code = 'const answer = 42;\nconsole.log(`answer: ${answer}`);';
  t.write('docs/code.md', `# コードの例\n\n\`\`\`ts\n${code}\n\`\`\`\n\n本文\n`);
  const opened = await t.json<{ documents: Array<{ documentId: string; displayPath: string }> }>([
    'open',
    'docs/code.md',
  ]);
  const document = opened.documents[0];
  if (!document) throw new Error('文書を開けませんでした');
  await page.goto(await t.bootstrapUrl());
  await expect(heading(page)).toHaveText('コードの例');
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const result = page.getByTestId('copy-result');

  await page.getByRole('button', { name: 'コードをcopy' }).click();
  await expect(result).toHaveText('コードをcopyしました。');
  expect(await clipboard()).toBe(code);

  await page.getByRole('button', { name: '文書のpathをcopy' }).click();
  await expect(result).toHaveText('文書のpathをcopyしました。');
  expect(await clipboard()).toBe(document.displayPath);

  await page.getByRole('button', { name: '文書のIDをcopy' }).click();
  await expect(result).toHaveText('文書のIDをcopyしました。');
  expect(await clipboard()).toBe(document.documentId);
});
