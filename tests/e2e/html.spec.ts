import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

const fixtures = fileURLToPath(new URL('../fixtures/security', import.meta.url));
// 1x1の、実際に表示できるPNG。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let t: E2eHome;
let beacon: Server | null;
let hits: string[];

test.beforeEach(() => {
  t = createE2eHome();
  beacon = null;
  hits = [];
});

test.afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (beacon) beacon.close(() => resolve());
    else resolve();
  });
  await t.cleanup();
});

// 届いたrequestを記録するだけのserver。文書やbackendが外部へ要求していないことを確かめる。
async function startBeacon(): Promise<string> {
  const server = createServer((request, response) => {
    hits.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    response.end('beacon');
  });
  beacon = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

interface ReleaseRecord {
  grants: string[];
  // 権限を返す処理を始めた瞬間に、画面に出ていた表示用URL。
  frame: string | null;
}

// 権限を返す処理を始めた瞬間に、画面に出ている表示用URLを記録する。
// 応答を待つ側で記録すると、記録するまでに画面が進んでしまうので、browserの中で同期的に記録する。
async function recordReleases(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const releases: Array<{ grants: string[]; frame: string | null }> = [];
    (window as unknown as { releases: typeof releases }).releases = releases;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/render-grants/release') && typeof init?.body === 'string') {
        releases.push({
          grants: (JSON.parse(init.body) as { grants: string[] }).grants,
          frame:
            document.querySelector('[data-testid="document-frame"]')?.getAttribute('src') ?? null,
        });
      }
      return original(input, init);
    };
  });
}

function readReleases(page: Page): Promise<ReleaseRecord[]> {
  return page.evaluate(() => (window as unknown as { releases: ReleaseRecord[] }).releases);
}

async function openHostile(page: Page): Promise<string> {
  const origin = await startBeacon();
  const html = readFileSync(join(fixtures, 'static-hostile.html'), 'utf8').replaceAll(
    '__BEACON__',
    origin,
  );
  t.write('site/index.html', html);
  t.write('site/img/a.png', PNG);
  t.write('site/css/site.css', `.from-file{font-weight:700} @import "${origin}/css-import.css";`);
  t.write('site/app.js', `fetch('${origin}/local-script')`);
  t.write('site/neighbor.md', '# 隣の文書\n');
  await t.json(['open', 'site/index.html']);
  await page.goto(await t.bootstrapUrl());
  await expect(page.getByTestId('document-frame')).toBeVisible();
  return origin;
}

test('P3 gate / SEC-005: 静的表示では、文書のscript・event属性・埋め込みが動かない', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  const origin = await openHostile(page);

  // 文書は、空のsandboxの中で、管理UIとは別のoriginから表示される。
  const frame = page.getByTestId('document-frame');
  await expect(frame).toHaveAttribute('sandbox', '');
  const src = (await frame.getAttribute('src')) as string;
  expect(new URL(src).origin).not.toBe(new URL(page.url()).origin);
  expect(new URL(src).pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{43}\/files\/index\.html$/);

  // 表示されている内容。scriptが書き換える前の文字のままで、実行される要素は残っていない。
  const inner = page.frameLocator('[data-testid="document-frame"]');
  await expect(inner.locator('#marker')).toHaveText('元の文字');
  await expect(inner.locator('#fallback')).toHaveText('scriptが動かないときの文');
  for (const selector of ['script', 'iframe', 'object', 'embed', 'svg', 'base', 'noscript']) {
    await expect(inner.locator(selector), selector).toHaveCount(0);
  }
  await expect(inner.locator('[onload], [onerror], [onclick]')).toHaveCount(0);
  // 登録済みのCSSと画像は使える。
  await expect(inner.locator('#styled')).toHaveCSS('color', 'rgb(0, 128, 0)');
  await expect(inner.locator('#styled')).toHaveCSS('font-weight', '700');
  await expect(inner.locator('#ok')).toHaveJSProperty('naturalWidth', 1);
  // linkは押せない。文書内の移動だけが残る。
  await expect(inner.locator('#external')).not.toHaveAttribute('href');
  await expect(inner.locator('#neighbor')).not.toHaveAttribute('href');
  await expect(inner.locator('#inner')).toHaveAttribute('href', '#marker');

  // meta refreshの待ち時間（1秒）を過ぎても、遷移も外部への要求も起きない。
  await page.waitForTimeout(2500);
  await expect(inner.locator('#marker')).toHaveText('元の文字');
  expect(await frame.getAttribute('src')).toBe(src);
  // SEC-006: 外部への要求を、browserの側でもserverの側でも観測していない。
  expect(requested.filter((url) => url.startsWith(origin))).toEqual([]);
  expect(hits).toEqual([]);
  // 記録用のserverそのものは届く状態にある（届かないから0件、ではない）。
  await page.request.get(`${origin}/self-check`);
  expect(hits).toEqual(['GET /self-check']);
  hits = [];

  // 取り除いたものと理由を、本体の画面で確かめられる。
  const diagnostics = page.getByTestId('render-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics).toContainText('scriptを3件取り除きました');
  await expect(diagnostics).toContainText('文書に直接書かれたSVGを1件取り除きました');
  await expect(diagnostics).toContainText('iframe・object・embedなどの埋め込みを4件取り除きました');
  await expect(diagnostics).toContainText('meta refresh');
  await expect(diagnostics).toContainText('missing.png が見つかりません');
  await expect(diagnostics).toContainText(
    `外部のURL（${origin}/remote-image.png）は読み込みません`,
  );
  // 枠の中が文書の内容であることと、表示の種類を、常に示す。
  await expect(page.getByText('ここから下は、開いた文書の内容です')).toBeVisible();
  await expect(page.getByText('静的表示', { exact: true })).toBeVisible();
});

test('SEC-004（部分）: 表示用の応答は、sandboxと、scriptを禁じるpolicyを持つ', async ({ page }) => {
  await openHostile(page);
  const src = (await page.getByTestId('document-frame').getAttribute('src')) as string;
  const response = await page.request.get(src);
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'none'");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain(`frame-ancestors ${new URL(page.url()).origin}`);
  expect(csp.split('; ').at(-1)).toBe('sandbox');
  expect(csp).not.toContain('allow-same-origin');
  expect(csp).not.toContain('allow-scripts');
  // 管理UIは、文書の表示（iframe）と登録済みの画像だけを、表示用のlistenerから読み込める。
  const ui = await page.request.get(new URL('/', page.url()).href);
  const uiCsp = ui.headers()['content-security-policy'] ?? '';
  expect(uiCsp).toContain(`frame-src ${new URL(src).origin}`);
  expect(uiCsp).toContain("script-src 'self'");
  expect(uiCsp).toContain("frame-ancestors 'none'");
  // 表示用のURLを直接開いても、管理UIは表示されず、scriptも動かない。
  const direct = await page.context().newPage();
  await direct.goto(src);
  await expect(direct.locator('#marker')).toHaveText('元の文字');
  expect(await direct.evaluate(() => 'pwned' in window).catch(() => 'blocked')).not.toBe(true);
  await direct.close();
});

test('SEC-019: 文書中のlinkは一覧から開き、未登録の文書は確認してから開く', async ({ page }) => {
  await openHostile(page);
  const sidebar = page.getByRole('navigation', { name: '開いている文書' });
  const links = page.getByTestId('render-links');
  await links.locator('summary').click();
  await expect(links.getByRole('link', { name: '外部へのlink' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );

  // 確認の画面で開かないを選ぶと、一覧は変わらない。
  await links.getByRole('button', { name: '隣の文書' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('この文書を一覧に追加して開きますか');
  await expect(dialog).toContainText('neighbor.md');
  await dialog.getByRole('button', { name: '開かない' }).click();
  await expect(dialog).toBeHidden();
  await expect(sidebar.getByRole('button', { name: '隣の文書', exact: true })).toHaveCount(0);
  expect((await t.json<{ totalDocuments: number }>(['list'])).totalDocuments).toBe(1);

  // 確認して開くと、一覧に加わり、表示が切り替わる。
  await links.getByRole('button', { name: '隣の文書' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '一覧に追加して開く' }).click();
  await expect(sidebar.getByRole('button', { name: '隣の文書', exact: true })).toBeVisible();
  await expect(page.locator('article')).toContainText('隣の文書');
  expect((await t.json<{ totalDocuments: number }>(['list'])).totalDocuments).toBe(2);
});

test('SEC-019: 確認の画面を出している間に文書が更新されても、開くのは確認した文書', async ({
  page,
}) => {
  t.write('site/index.html', '<a href="first.md">link</a>');
  t.write('site/first.md', '# 確認した文書\n');
  t.write('site/second.md', '# 更新後の行き先\n');
  await t.json(['open', 'site/index.html']);
  await page.goto(await t.bootstrapUrl());
  const links = page.getByTestId('render-links');
  await links.locator('summary').click();
  await links.getByRole('button', { name: 'link' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('first.md');

  // 確認の画面を出したまま、同じ番号のlinkの行き先が変わる。
  const before = await page.getByTestId('document-frame').getAttribute('src');
  t.atomicWrite('site/index.html', '<a href="second.md">link</a>');
  await expect(page.getByTestId('document-frame')).not.toHaveAttribute('src', before as string);
  await expect(dialog).toContainText('first.md');

  // 開くのは、画面に示して確認した文書。更新後の行き先は開かない。
  await dialog.getByRole('button', { name: '一覧に追加して開く' }).click();
  const sidebar = page.getByRole('navigation', { name: '開いている文書' });
  await expect(sidebar.getByRole('button', { name: '確認した文書', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '更新後の行き先', exact: true })).toHaveCount(0);
});

test('Markdownの画像は登録済みのlocal fileだけを表示し、相対linkは確認してから開く', async ({
  page,
}) => {
  const origin = await startBeacon();
  t.write(
    'docs/a.md',
    `# 画像のある文書\n\n![図](img/a.png) ![外部](${origin}/remote.png) ![無い](img/missing.png)\n\n[次の文書](b.md)\n`,
  );
  t.write('docs/img/a.png', PNG);
  t.write('docs/b.md', '# 次の文書\n');
  await t.json(['open', 'docs/a.md']);
  await page.goto(await t.bootstrapUrl());

  const image = page.locator('article img');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveJSProperty('naturalWidth', 1);
  expect(new URL((await image.getAttribute('src')) as string).pathname).toMatch(
    /^\/r\/[A-Za-z0-9_-]{43}\/files\/img\/a\.png$/,
  );
  // 表示できない画像は、代替の文字にする。外部へは要求しない。
  await expect(page.locator('article [data-blocked-image]')).toHaveText(['[画像: 無い]']);
  await expect(page.locator('article')).toContainText('外部');
  const diagnostics = page.getByTestId('render-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics).toContainText('img/missing.png が見つかりません');
  await expect(diagnostics).toContainText(`外部のURL（${origin}/remote.png）は読み込みません`);
  expect(hits).toEqual([]);

  await page.locator('article').getByRole('button', { name: '次の文書' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '一覧に追加して開く' }).click();
  await expect(page.locator('article')).toContainText('次の文書');
  await expect(
    page
      .getByRole('navigation', { name: '開いている文書' })
      .getByRole('button', { name: '次の文書', exact: true }),
  ).toBeVisible();
});

test('表示の権限は、必要なときだけ取り直し、表示を差し替えてから前の権限を返す', async ({
  page,
}) => {
  t.write('site/index.html', '<h1 id="h">参照のない文書</h1>');
  await t.json(['open', 'site/index.html']);

  // 権限の発行の応答を制御する。inject: 「参照を調べられなかった」という注意を足す。fail: 失敗させる。
  let mode: 'pass' | 'inject' | 'fail' = 'inject';
  const issued: string[] = [];
  let attempts = 0;
  // 権限の発行と返却を、起きた順に記録する。
  const timeline: string[] = [];
  await page.route('**/_/api/v1/documents/*/render-grants', async (route) => {
    attempts += 1;
    if (mode === 'fail') {
      timeline.push('issue-failed');
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: 'E_INTERNAL', message: '失敗', retryable: false, details: {} },
          warnings: [],
        }),
      });
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: { grant: string; diagnostics: Array<Record<string, unknown>> };
    };
    if (mode === 'inject') {
      body.data.diagnostics.unshift({ code: 'asset-scan-failed', target: null, count: 1 });
    }
    issued.push(body.data.grant);
    timeline.push(`issued:${String(issued.length)}`);
    await route.fulfill({ response, json: body });
  });
  await page.route('**/_/api/v1/render-grants/release', async (route) => {
    const { grants } = route.request().postDataJSON() as { grants: string[] };
    for (const grant of grants) timeline.push(`released:${String(issued.indexOf(grant) + 1)}`);
    await route.continue();
  });
  await recordReleases(page);
  // 版を変えずに、文書の状態（更新時刻）だけを変える。
  const touch = (title: string) => t.json(['open', 'site/index.html', '--title', title]);
  const heading = (name: string) => page.getByRole('heading', { level: 1, name });

  await page.goto(await t.bootstrapUrl());
  const frame = page.getByTestId('document-frame');
  const inner = page.frameLocator('[data-testid="document-frame"]');
  const diagnostics = page.getByTestId('render-diagnostics');
  await expect(inner.locator('#h')).toHaveText('参照のない文書');
  await expect(diagnostics).toContainText('元の文書と表示が異なる点');

  // 初回の取得は1回だけ。注意が含まれていても、それを理由に取り直さず、取得した権限も返さない。
  await page.waitForTimeout(700);
  expect(attempts).toBe(1);
  expect(timeline).toEqual(['issued:1']);
  const firstUrl = await frame.getAttribute('src');
  expect((await page.request.get(firstUrl as string)).status()).toBe(200);

  // 取り直しに失敗しても、表示中の権限と内容を保つ。失敗を理由に、取り直しを繰り返さない。
  mode = 'fail';
  await touch('名前1');
  await expect(heading('名前1')).toBeVisible();
  await expect.poll(() => attempts).toBe(2);
  await page.waitForTimeout(700);
  expect(attempts).toBe(2);
  expect(timeline).toEqual(['issued:1', 'issue-failed']);
  expect(await frame.getAttribute('src')).toBe(firstUrl);
  await expect(inner.locator('#h')).toHaveText('参照のない文書');
  await expect(diagnostics).toBeVisible();
  expect((await page.request.get(firstUrl as string)).status()).toBe(200);

  // 文書の状態が更新されると、もう一度取り直す。調べ終えていれば、注意が消える。
  mode = 'pass';
  await touch('名前2');
  await expect(heading('名前2')).toBeVisible();
  await expect(diagnostics).toHaveCount(0);
  await expect(frame).not.toHaveAttribute('src', firstUrl as string);
  await expect(inner.locator('#h')).toHaveText('参照のない文書');
  // 前の権限を返すのは、新しい権限を受け取った後。
  await expect.poll(() => timeline).toEqual(['issued:1', 'issue-failed', 'issued:2', 'released:1']);
  // 返す処理を始めた時点で、画面の表示は新しい権限のURLへ差し替わっている。
  // 画面に出ている表示の権限を、先に返してはいない。
  const releases = await readReleases(page);
  expect(releases).toHaveLength(1);
  expect(releases[0]?.grants).toEqual([issued[0]]);
  expect(releases[0]?.frame).toContain(`/r/${issued[1] ?? ''}/`);
  await expect.poll(async () => (await page.request.get(firstUrl as string)).status()).toBe(404);
  const secondUrl = await frame.getAttribute('src');

  // 調べ終えた文書は、文書の状態が更新されても取り直さない。表示も作り直さない。
  await touch('名前3');
  await expect(heading('名前3')).toBeVisible();
  await page.waitForTimeout(700);
  expect(attempts).toBe(3);
  expect(await frame.getAttribute('src')).toBe(secondUrl);
  expect((await page.request.get(secondUrl as string)).status()).toBe(200);

  // 別の文書へ切り替えて表示をやめると、使っていた権限を返す。
  t.write('other.md', '# 別の文書\n');
  await t.json(['open', 'other.md']);
  await page
    .getByRole('navigation', { name: '開いている文書' })
    .getByRole('button', { name: '別の文書', exact: true })
    .click();
  await expect(page.locator('article')).toContainText('別の文書');
  await expect.poll(async () => (await page.request.get(secondUrl as string)).status()).toBe(404);
  expect(timeline.filter((entry) => entry === 'released:2')).toHaveLength(1);
});

test('HTMLの文書を更新すると表示を作り直し、原文へ切り替えても文書は動かない', async ({ page }) => {
  t.write('site/index.html', '<h1 id="h">版1</h1><script>document.title = "x"</script>');
  await t.json(['open', 'site/index.html']);
  await recordReleases(page);
  await page.goto(await t.bootstrapUrl());
  const inner = page.frameLocator('[data-testid="document-frame"]');
  await expect(inner.locator('#h')).toHaveText('版1');
  const first = await page.getByTestId('document-frame').getAttribute('src');

  t.atomicWrite('site/index.html', '<h1 id="h">版2</h1>');
  await expect(inner.locator('#h')).toHaveText('版2');
  // 版が変わると、表示用のURLも変わる。前のURLは、返した後は使えない。
  const second = await page.getByTestId('document-frame').getAttribute('src');
  expect(second).not.toBe(first);
  await expect.poll(async () => (await page.request.get(first as string)).status()).toBe(404);
  // 前の版の権限を返し始めた時点で、画面に前の版の表示は残っていない。
  const releases = await readReleases(page);
  expect(releases).toHaveLength(1);
  expect(first).toContain(`/r/${releases[0]?.grants[0] ?? ''}/`);
  expect(releases[0]?.frame).not.toBe(first);

  // 原文の表示では、HTMLを文字として示す。
  await page.getByRole('button', { name: '原文' }).click();
  await expect(page.getByTestId('document-frame')).toHaveCount(0);
  await expect(page.getByTestId('document-body')).toContainText('<h1 id="h">版2</h1>');
});
