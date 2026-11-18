import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

const fixtures = fileURLToPath(new URL('../fixtures/security', import.meta.url));
// A 1x1 PNG that actually renders.
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

// A server that only records incoming requests. Confirms that neither the document nor the backend makes outbound requests.
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
  // The render URL on screen at the moment the release started.
  frame: string | null;
}

// Record the render URL on screen at the moment a release starts.
// Recording on the response side is too late (the screen moves on), so record synchronously inside the browser.
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
  await page.goto(await t.uiUrl());
  await expect(page.getByTestId('document-frame')).toBeVisible();
  return origin;
}

test('P3 gate / SEC-005: in the Static view, the document scripts, event attributes, and embeds do not run', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  const origin = await openHostile(page);

  // The document has an opaque origin. Only the app relay is allowed to run by the response CSP.
  const frame = page.getByTestId('document-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const src = (await frame.getAttribute('src')) as string;
  expect(new URL(src).origin).not.toBe(new URL(page.url()).origin);
  expect(new URL(src).pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{43}\/files\/index\.html$/);

  // The shown content retains the author's text, with only the app relay script.
  const inner = page.frameLocator('[data-testid="document-frame"]');
  await expect(inner.locator('#marker')).toHaveText('元の文字');
  await expect(inner.locator('#fallback')).toHaveText('scriptが動かないときの文');
  await expect(inner.locator('script')).toHaveCount(1);
  for (const selector of ['iframe', 'object', 'embed', 'svg', 'base', 'noscript']) {
    await expect(inner.locator(selector), selector).toHaveCount(0);
  }
  await expect(inner.locator('[onload], [onerror], [onclick]')).toHaveCount(0);
  // Registered CSS and images work.
  await expect(inner.locator('#styled')).toHaveCSS('color', 'rgb(0, 128, 0)');
  await expect(inner.locator('#styled')).toHaveCSS('font-weight', '700');
  await expect(inner.locator('#ok')).toHaveJSProperty('naturalWidth', 1);
  // Local document links are relayed by ID. The original heading link still works in the frame.
  await expect(inner.locator('#external')).not.toHaveAttribute('href');
  await expect(inner.locator('#neighbor')).toHaveAttribute('href', '#');
  await expect(inner.locator('#inner')).toHaveAttribute('href', '#marker');

  // Even after the meta refresh delay (1 second), neither navigation nor an outbound request happens.
  await page.waitForTimeout(2500);
  await expect(inner.locator('#marker')).toHaveText('元の文字');
  expect(await frame.getAttribute('src')).toBe(src);
  // SEC-006: no outbound request was observed on either the browser side or the server side.
  expect(requested.filter((url) => url.startsWith(origin))).toEqual([]);
  expect(hits).toEqual([]);
  // The recording server itself is reachable (zero hits is not because it was unreachable).
  await page.request.get(`${origin}/self-check`);
  expect(hits).toEqual(['GET /self-check']);
  hits = [];

  // What was removed, and why, can be checked in the management UI.
  await page.getByTestId('html-view-bar').getByTestId('render-diagnostics').click();
  const diagnostics = page.getByRole('dialog', { name: 'Differences from the original document' });
  await expect(diagnostics).toContainText('Removed 3 scripts');
  await expect(diagnostics).toContainText('Removed 1 inline SVG');
  await expect(diagnostics).toContainText('Removed 4 embedded elements');
  await expect(diagnostics).toContainText('meta refresh');
  await expect(diagnostics).toContainText('missing.png was not found');
  await expect(diagnostics).toContainText(
    `External URL (${origin}/remote-image.png) is not loaded`,
  );
  // Always show that the frame holds the document content, and which view mode is in use.
  await expect(
    page.getByTestId('html-view-bar').getByText('Document content', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('html-mode')).toBeVisible();
});

test('SEC-004 (partial): the Static render response allows only the app relay script', async ({
  page,
}) => {
  await openHostile(page);
  const src = (await page.getByTestId('document-frame').getAttribute('src')) as string;
  const response = await page.request.get(src);
  const csp = response.headers()['content-security-policy'] ?? '';
  const relay = await page
    .frameLocator('[data-testid="document-frame"]')
    .locator('script')
    .textContent();
  const hash = createHash('sha256')
    .update(relay ?? '')
    .digest('base64');
  expect(csp.split('; ').find((directive) => directive.startsWith('script-src '))).toBe(
    `script-src 'sha256-${hash}'`,
  );
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain(`frame-ancestors ${new URL(page.url()).origin}`);
  expect(csp.split('; ').at(-1)).toBe('sandbox allow-scripts');
  expect(csp).not.toContain('allow-same-origin');
  // The management UI may load only the document view (iframe) and registered images from the render listener.
  const ui = await page.request.get(new URL('/', page.url()).href);
  const uiCsp = ui.headers()['content-security-policy'] ?? '';
  expect(uiCsp).toContain(`frame-src ${new URL(src).origin}`);
  expect(uiCsp).toContain("script-src 'self'");
  expect(uiCsp).toContain("frame-ancestors 'none'");
  // Opening the render URL directly still shows the original text with author scripts blocked.
  const direct = await page.context().newPage();
  await direct.goto(src);
  await expect(direct.locator('#marker')).toHaveText('元の文字');
  expect(await direct.evaluate(() => 'pwned' in window).catch(() => 'blocked')).not.toBe(true);
  await direct.close();
});

test('SEC-019: links in the document open from the list, and unregistered documents are confirmed before opening', async ({
  page,
}) => {
  await openHostile(page);
  const sidebar = page.getByRole('navigation', { name: 'Open documents' });
  await page.getByTestId('html-view-bar').getByTestId('render-links').click();
  const links = page.getByRole('dialog', { name: 'Links in this document' });
  await expect(links.getByRole('link', { name: '外部へのlink' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );

  // Choosing "Don't open" in the confirmation leaves the list unchanged.
  await links.getByRole('button', { name: '隣の文書' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Add this document to the list and open it?');
  await expect(dialog).toContainText('neighbor.md');
  await dialog.getByRole('button', { name: "Don't open" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('render-links')).toBeFocused();
  await expect(sidebar.getByRole('button', { name: '隣の文書', exact: true })).toHaveCount(0);
  expect((await t.json<{ totalDocuments: number }>(['list'])).totalDocuments).toBe(1);

  // Confirming adds it to the list and switches the view.
  await page.getByTestId('render-links').click();
  await links.getByRole('button', { name: '隣の文書' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Add to list and open' }).click();
  await expect(sidebar.getByRole('button', { name: '隣の文書', exact: true })).toBeVisible();
  await expect(page.locator('article')).toContainText('隣の文書');
  expect((await t.json<{ totalDocuments: number }>(['list'])).totalDocuments).toBe(2);
});

for (const mode of ['static', 'interactive'] as const) {
  test(`SEC-019: local body links open from the ${mode} HTML preview`, async ({ page }) => {
    t.write(
      'site/index.html',
      `<h1>Source</h1>
       <noscript><a href="./decoy.md">Static-only link</a></noscript>
       <h2 id="links">Open files</h2>
       <a href="./details.html"><span>Details</span></a>
       <a href="./doc.md">Notes</a>`,
    );
    const destination = realpathSync(t.write('site/details.html', '<h1>HTML destination</h1>'));
    t.write('site/doc.md', '# Markdown destination\n');
    t.write('site/decoy.md', '# Wrong destination\n');
    await t.json(['open', 'site/index.html', '--html-mode', mode]);
    const linkRequests: string[] = [];
    page.on('request', (request) => {
      if (/\/links\/[^/]+\/open$/.test(request.url())) linkRequests.push(request.url());
    });
    await page.goto(await t.uiUrl());

    const inner = page
      .locator('[data-testid="document-workspace"]:not([inert])')
      .frameLocator('[data-testid="document-frame"]');
    const link = inner.getByRole('link', { name: 'Details' });
    await expect(link).toBeVisible();
    if (mode === 'static') {
      await page
        .getByRole('complementary', { name: 'Outline' })
        .getByRole('button', { name: 'Open files' })
        .click();
      await expect
        .poll(() => link.evaluate((element) => element.ownerDocument.location.hash))
        .toBe('#links');
    } else {
      await expect(inner.getByText('Static-only link')).toHaveCount(0);
    }
    await inner.getByRole('link', { name: 'Notes' }).evaluate((element) => {
      if (element instanceof HTMLAnchorElement) element.click();
    });

    const sidebar = page.getByRole('navigation', { name: 'Open documents' });
    const source = sidebar.getByRole('button', { name: 'index.html', exact: true });
    const details = sidebar.getByRole('button', { name: 'details.html', exact: true });
    const dialog = page.getByRole('alertdialog');
    await link.locator('span').click();
    await expect(dialog).toContainText(destination);
    expect(linkRequests).toHaveLength(1);
    await dialog.getByRole('button', { name: "Don't open" }).click();
    await expect(dialog).toBeHidden();
    await expect(details).toHaveCount(0);

    await link.press('Enter');
    await expect(dialog).toContainText(destination);
    await dialog.getByRole('button', { name: 'Add to list and open' }).click();
    await expect(details).toHaveAttribute('aria-current', 'true');
    await expect(inner.getByRole('heading', { name: 'HTML destination' })).toBeVisible();

    await source.click();
    await link.click();
    await expect(details).toHaveAttribute('aria-current', 'true');
    await expect(inner.getByRole('heading', { name: 'HTML destination' })).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(linkRequests).toHaveLength(4);

    await source.click();
    await inner.getByRole('link', { name: 'Notes' }).click();
    await expect(dialog).toContainText('doc.md');
    await dialog.getByRole('button', { name: 'Add to list and open' }).click();
    await expect(page.locator('article')).toContainText('Markdown destination');
  });
}

test('SEC-019: if the document is updated while the confirmation is shown, the document that was confirmed is the one opened', async ({
  page,
}) => {
  t.write('site/index.html', '<a href="first.md">link</a>');
  t.write('site/first.md', '# 確認した文書\n');
  t.write('site/second.md', '# 更新後の行き先\n');
  await t.json(['open', 'site/index.html']);
  await page.goto(await t.uiUrl());
  await page
    .frameLocator('[data-testid="document-frame"]')
    .getByRole('link', { name: 'link' })
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('first.md');

  // With the confirmation still shown, the target of the link with the same number changes.
  const before = await page.getByTestId('document-frame').getAttribute('src');
  t.atomicWrite('site/index.html', '<a href="second.md">link</a>');
  await expect(page.getByTestId('document-frame')).not.toHaveAttribute('src', before as string);
  await expect(dialog).toContainText('first.md');

  // What opens is the document shown and confirmed on screen. The updated target does not open.
  await dialog.getByRole('button', { name: 'Add to list and open' }).click();
  const sidebar = page.getByRole('navigation', { name: 'Open documents' });
  await expect(sidebar.getByRole('button', { name: '確認した文書', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '更新後の行き先', exact: true })).toHaveCount(0);
});

test('SEC-019: a link that fails to open is reported in the notices row and can be opened again', async ({
  page,
}) => {
  t.write('site/index.html', '<a href="first.md">link</a>');
  t.write('site/first.md', '# 開く文書\n');
  await t.json(['open', 'site/index.html']);
  await page.goto(await t.uiUrl());
  const openRoute = /\/_\/api\/v1\/documents\/[^/]+\/links\/[^/]+\/open/;
  await page.route(openRoute, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: 'failed' } }),
    }),
  );
  await page.getByTestId('render-links').click();
  const link = page
    .getByRole('dialog', { name: 'Links in this document' })
    .getByRole('button', { name: 'link' });
  await link.click();
  const notice = page
    .getByTestId('document-notices')
    .getByRole('button', { name: 'Could not open link' });
  await expect(notice).toBeVisible();

  await page.unroute(openRoute);
  await link.click();
  await expect(page.getByRole('alertdialog')).toContainText('first.md');
  await expect(notice).toHaveCount(0);
});

test('Markdown images show only registered local files, and relative links are confirmed before opening', async ({
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
  await page.goto(await t.uiUrl());

  const image = page.locator('article img');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveJSProperty('naturalWidth', 1);
  expect(new URL((await image.getAttribute('src')) as string).pathname).toMatch(
    /^\/r\/[A-Za-z0-9_-]{43}\/files\/img\/a\.png$/,
  );
  // Images that cannot be shown become placeholder text. No outbound request is made.
  await expect(page.locator('article [data-blocked-image]')).toHaveText(['[image: 無い]']);
  await expect(page.locator('article')).toContainText('外部');
  await page.getByTestId('document-notices').getByTestId('render-diagnostics').click();
  const diagnostics = page.getByRole('dialog', { name: 'Differences from the original document' });
  await expect(diagnostics).toContainText('img/missing.png was not found');
  await expect(diagnostics).toContainText(`External URL (${origin}/remote.png) is not loaded`);
  expect(hits).toEqual([]);
  await diagnostics.getByRole('button', { name: 'Close details' }).click();

  await page.locator('article').getByRole('button', { name: '次の文書' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Add to list and open' }).click();
  await expect(page.locator('article')).toContainText('次の文書');
  await expect(
    page
      .getByRole('navigation', { name: 'Open documents' })
      .getByRole('button', { name: '次の文書', exact: true }),
  ).toBeVisible();
});

test('render grants are refetched only when needed, and the previous grant is released after the view is replaced', async ({
  page,
}) => {
  t.write('site/index.html', '<h1 id="h">参照のない文書</h1>');
  await t.json(['open', 'site/index.html']);

  // Control the grant-issuing response. inject: add the "references could not be scanned" note. fail: make it fail.
  let mode: 'pass' | 'inject' | 'fail' = 'inject';
  const issued: string[] = [];
  let attempts = 0;
  // Record grant issues and releases in the order they happen.
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
          error: { code: 'E_INTERNAL', message: 'failed', retryable: false, details: {} },
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
  // Change only the document's state (update time), without changing the revision.
  const touch = (title: string) => t.json(['open', 'site/index.html', '--title', title]);
  const heading = (name: string) => page.getByRole('heading', { level: 1, name });

  await page.goto(await t.uiUrl());
  const frame = page.getByTestId('document-frame');
  const inner = page.frameLocator('[data-testid="document-frame"]');
  const diagnostics = page.getByTestId('render-diagnostics');
  await expect(inner.locator('#h')).toHaveText('参照のない文書');
  await expect(diagnostics).toContainText('Differences');

  // The first fetch happens once. Even with the note included, it is not a reason to refetch, and the fetched grant is not released.
  await page.waitForTimeout(700);
  expect(attempts).toBe(1);
  expect(timeline).toEqual(['issued:1']);
  const firstUrl = await frame.getAttribute('src');
  expect((await page.request.get(firstUrl as string)).status()).toBe(200);

  // When a refetch fails, the grant and content in use are kept. The failure is not a reason to keep retrying.
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

  // When the document's state is updated, refetch once more. Once the scan has finished, the note disappears.
  mode = 'pass';
  await touch('名前2');
  await expect(heading('名前2')).toBeVisible();
  await expect(diagnostics).toHaveCount(0);
  await expect(frame).not.toHaveAttribute('src', firstUrl as string);
  await expect(inner.locator('#h')).toHaveText('参照のない文書');
  // The previous grant is released after the new grant is received.
  await expect.poll(() => timeline).toEqual(['issued:1', 'issue-failed', 'issued:2', 'released:1']);
  // At the moment the release starts, the on-screen view has already switched to the new grant's URL.
  // The grant of the view on screen was not released first.
  const releases = await readReleases(page);
  expect(releases).toHaveLength(1);
  expect(releases[0]?.grants).toEqual([issued[0]]);
  expect(releases[0]?.frame).toContain(`/r/${issued[1] ?? ''}/`);
  await expect.poll(async () => (await page.request.get(firstUrl as string)).status()).toBe(404);
  const secondUrl = await frame.getAttribute('src');

  // A document whose scan finished is not refetched when its state is updated. The view is not rebuilt either.
  await touch('名前3');
  await expect(heading('名前3')).toBeVisible();
  await page.waitForTimeout(700);
  expect(attempts).toBe(3);
  expect(await frame.getAttribute('src')).toBe(secondUrl);
  expect((await page.request.get(secondUrl as string)).status()).toBe(200);

  // Switching to another document dismisses the view and releases the grant in use.
  t.write('other.md', '# 別の文書\n');
  await t.json(['open', 'other.md']);
  await page
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', { name: '別の文書', exact: true })
    .click();
  await expect(page.locator('article')).toContainText('別の文書');
  await expect.poll(async () => (await page.request.get(secondUrl as string)).status()).toBe(404);
  expect(timeline.filter((entry) => entry === 'released:2')).toHaveLength(1);
});

test('updating an HTML document rebuilds the view, and switching to Source does not run the document', async ({
  page,
}) => {
  t.write('site/index.html', '<h1 id="h">版1</h1><script>document.title = "x"</script>');
  await t.json(['open', 'site/index.html']);
  await recordReleases(page);
  await page.goto(await t.uiUrl());
  const inner = page.frameLocator('[data-testid="document-frame"]');
  await expect(inner.locator('#h')).toHaveText('版1');
  const first = await page.getByTestId('document-frame').getAttribute('src');

  t.atomicWrite('site/index.html', '<h1 id="h">版2</h1>');
  await expect(inner.locator('#h')).toHaveText('版2');
  // When the revision changes, the render URL changes too. The previous URL stops working once released.
  const second = await page.getByTestId('document-frame').getAttribute('src');
  expect(second).not.toBe(first);
  await expect.poll(async () => (await page.request.get(first as string)).status()).toBe(404);
  // At the moment the previous revision's grant release started, the previous revision's view was no longer on screen.
  const releases = await readReleases(page);
  expect(releases).toHaveLength(1);
  expect(first).toContain(`/r/${releases[0]?.grants[0] ?? ''}/`);
  expect(releases[0]?.frame).not.toBe(first);

  // The Source view shows the HTML as text.
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(page.getByTestId('document-frame')).toHaveCount(0);
  await expect(page.getByTestId('document-body')).toContainText('<h1 id="h">版2</h1>');
});

test('jumping from the outline moves the Static view to the heading, without adding history', async ({
  page,
}) => {
  const filler = Array.from({ length: 120 }, (_, index) => `<p>段落${String(index)}</p>`).join('');
  t.write('a.md', '# 前の文書\n');
  t.write(
    'doc.html',
    `<!doctype html><title>設計HTML</title><h1>文書</h1>${filler}<h2>中間</h2>${filler}` +
      `<object><h2>削除</h2></object><h2 id="last">最後</h2>${filler}` +
      // %E9%87%8D is the fragment of 重: the browser finds the heading written that way first.
      `<h2 id="日本語の節">日本語のid</h2>${filler}<h2 id="%E9%87%8D">表記のid</h2>${filler}` +
      `<h2 id="重">重なるid</h2>${filler}`,
  );
  await t.json(['open', 'a.md', 'doc.html']);
  await page.goto(await t.uiUrl());
  const shown = page
    .getByRole('region', { name: 'Document view' })
    .getByRole('heading', { level: 1 })
    .first();
  await expect(shown).toHaveText('前の文書');
  await page
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', { name: '設計HTML', exact: true })
    .click();
  await expect(shown).toHaveText('設計HTML');

  const outline = page.getByRole('complementary', { name: 'Outline' });
  const frame = page.frameLocator('[data-testid="document-frame"]');
  const top = frame.getByRole('heading', { name: '文書' });
  const middle = frame.getByRole('heading', { name: '中間' });
  const last = frame.getByRole('heading', { name: '最後' });
  await expect(middle).toBeAttached();
  await expect(middle).not.toBeInViewport();
  // The heading inside object is removed from the view, and the fragment of 重 reaches another heading first,
  // so the outline cannot jump to them.
  await expect(outline.getByRole('button', { name: '削除' })).toBeDisabled();
  await expect(outline.getByRole('button', { name: '重なるid' })).toBeDisabled();
  const length = await page.evaluate(() => window.history.length);

  await outline.getByRole('button', { name: '中間' }).click();
  await expect(middle).toBeInViewport();
  await outline.getByRole('button', { name: '最後' }).click();
  await expect(last).toBeInViewport();
  await expect(middle).not.toBeInViewport();
  await outline.getByRole('button', { name: '中間' }).click();
  await expect(middle).toBeInViewport();
  // After reading elsewhere, the same item jumps again.
  await top.scrollIntoViewIfNeeded();
  await expect(middle).not.toBeInViewport();
  await outline.getByRole('button', { name: '中間' }).click();
  await expect(middle).toBeInViewport();
  // Ids that are not ASCII, and ids written percent-encoded, are reached through the encoded fragment.
  for (const name of ['日本語のid', '表記のid']) {
    await outline.getByRole('button', { name }).click();
    await expect(frame.getByRole('heading', { name })).toBeInViewport();
  }

  expect(await page.evaluate(() => window.history.length)).toBe(length);
  await page.goBack();
  await expect(shown).toHaveText('前の文書');
});

test('the heading jumped to in the Static view is kept in the URL, and a reload jumps to it again', async ({
  page,
}) => {
  const filler = Array.from({ length: 120 }, (_, index) => `<p>段落${String(index)}</p>`).join('');
  t.write(
    'doc.html',
    `<!doctype html><title>設計HTML</title><h1>文書</h1>${filler}<h2>中間</h2>${filler}<h2>最後</h2>${filler}`,
  );
  await t.json(['open', 'doc.html']);
  await page.goto(await t.uiUrl());
  const outline = page.getByRole('complementary', { name: 'Outline' });
  const middle = page
    .frameLocator('[data-testid="document-frame"]')
    .getByRole('heading', { name: '中間' });
  await expect(middle).toBeAttached();
  await expect(middle).not.toBeInViewport();

  await outline.getByRole('button', { name: '中間' }).click();
  await expect(middle).toBeInViewport();
  await expect(page).toHaveURL(/[?&]heading=/);

  await page.reload();
  await expect(middle).toBeInViewport();
});
