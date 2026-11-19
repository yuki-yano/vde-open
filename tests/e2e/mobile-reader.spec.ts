import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { createDaemonControl } from '../../apps/cli/src/cli/daemon-control.ts';
import { createE2eHome, type E2eHome } from './harness.ts';
import {
  MOBILE_HOST,
  MOBILE_LOGIN,
  MOBILE_UI_URL,
  startMobileProxy,
  type MobileProxy,
} from './mobile-proxy.ts';

// The phone reader (ADR-0017) in real browsers over real HTTPS (a local stand-in for Tailscale Serve).
let t: E2eHome;
let proxy: MobileProxy;

async function localPorts(): Promise<{ ui: number; preview: number }> {
  const connection = await createDaemonControl({
    env: { VDE_OPEN_HOME: t.home },
    platform: process.platform,
    homeDir: '',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  }).connectExisting();
  if (!connection) throw new Error('the daemon is not running');
  try {
    const envelope = await connection.request<{
      mobileBoundPorts?: { ui: number; preview: number };
    }>('daemon.diagnostics', {});
    const ports = envelope.ok ? envelope.data.mobileBoundPorts : undefined;
    if (!ports) throw new Error('the phone reader is not ready');
    return ports;
  } finally {
    connection.close();
  }
}

function settings(extra: Record<string, unknown> = {}) {
  mkdirSync(t.home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(t.home, 'listeners.json'),
    JSON.stringify({ ...extra, mobile: { host: MOBILE_HOST, login: MOBILE_LOGIN } }),
  );
}

test.beforeEach(async () => {
  t = createE2eHome();
  settings();
  proxy = await startMobileProxy(localPorts);
});
test.afterEach(async () => {
  await proxy.close();
  await t.cleanup();
});

async function phone(browser: Browser, viewport = { width: 390, height: 844 }): Promise<Page> {
  const context = await browser.newContext({
    proxy: { server: proxy.server },
    ignoreHTTPSErrors: true,
    viewport,
    hasTouch: true,
    isMobile: browser.browserType().name() !== 'firefox',
  });
  return context.newPage();
}

const DEMO = `<!doctype html><html><head><title>デモ</title></head><body>
<p id="value">loading</p><p id="missing">pending</p>
<button id="a" type="button">系列A</button><button id="b" type="button">系列B</button>
<input id="slider" type="range" min="0" max="10" value="0" aria-label="量"><span id="level">0</span>
<script src="app.js"></script></body></html>`;
const APP = `let data = null;
const value = document.getElementById('value');
const show = (key) => { value.textContent = key + ':' + data[key].join(','); };
fetch('data.json').then((r) => r.json()).then((d) => { data = d; show('a'); });
document.getElementById('a').addEventListener('click', () => show('a'));
document.getElementById('b').addEventListener('click', () => show('b'));
const slider = document.getElementById('slider');
slider.addEventListener('input', () => { document.getElementById('level').textContent = slider.value; });
fetch('missing.json').then((r) => { document.getElementById('missing').textContent = String(r.status); },
  () => { document.getElementById('missing').textContent = 'blocked'; });`;

function writeDemo(data = '{"a":[1,2,3],"b":[4,5,6]}') {
  t.write('demo.html', DEMO);
  t.write('app.js', APP);
  t.write('data.json', data);
}
const openDemo = () =>
  t.json([
    'open',
    'demo.html',
    '--no-open',
    '--html-mode',
    'interactive',
    '--asset',
    'app.js',
    '--asset',
    'data.json',
  ]);

// Scroll by a real wheel at the middle of `at` (on screen). Mobile WebKit has no wheel input; there `scroller`
// (an element, or the body of a frame's document) scrolls itself. Whether anything covers it is checked separately.
async function scrollOver(page: Page, at: Locator, scroller: Locator, dy: number): Promise<void> {
  const area = await at.boundingBox();
  if (!area) throw new Error('nothing to scroll on screen');
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  try {
    await page.mouse.wheel(0, dy);
  } catch (error) {
    if (!String(error).includes('not supported in mobile WebKit')) throw error;
    await scroller.evaluate((element, by) => {
      if (element.tagName === 'BODY') element.ownerDocument.defaultView?.scrollBy(0, by);
      else element.scrollBy(0, by);
    }, dy);
  }
}

const list = (page: Page) => page.getByRole('navigation', { name: 'Open documents' });
const titles = (page: Page) => list(page).locator('[data-part="title"]');
const frameOf = (page: Page) => page.frameLocator('[data-testid="document-frame"]');

test('Lanes 1 and 4: Markdown with its image and a registered JS + JSON demo on the phone; the PC keeps its own document', async ({
  page,
  browser,
}) => {
  t.write('pic.png', readFileSync(new URL('../fixtures/images/sample.png', import.meta.url)));
  t.write('note.md', '# 画像メモ\n\n![図](pic.png)\n');
  t.write('other.md', '# PCで見ている文書\n');
  writeDemo();
  await t.json(['open', 'note.md', 'other.md', '--no-open']);
  await openDemo();
  const { documents } = await t.json<{ documents: Array<{ documentId: string; title: string }> }>([
    'list',
  ]);
  const other =
    documents.find((document) => document.title === 'PCで見ている文書')?.documentId ?? '';
  await page.goto(`${await t.uiUrl()}?document=${other}`);
  await expect(page.getByRole('heading', { name: 'PCで見ている文書' }).first()).toBeVisible();

  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  // Newest opened first.
  await expect(titles(mobile)).toHaveText(['デモ', 'PCで見ている文書', '画像メモ']);
  await list(mobile).getByRole('button', { name: 'デモ' }).click();
  await expect(mobile.getByTestId('document-frame')).toHaveAttribute('data-mode', 'interactive');
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  await frameOf(mobile).getByRole('button', { name: '系列B' }).tap();
  await expect(frameOf(mobile).locator('#value')).toHaveText('b:4,5,6');
  // An unregistered file is never served to the demo.
  await expect(frameOf(mobile).locator('#missing')).toHaveText(/blocked|404/);
  await mobile.screenshot({ path: test.info().outputPath('demo-json.png') });

  await mobile.getByRole('button', { name: 'Back to the documents' }).click();
  await list(mobile).getByRole('button', { name: '画像メモ' }).click();
  const image = mobile.getByRole('img', { name: '図' });
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  expect(await image.getAttribute('src')).toContain(`https://${MOBILE_HOST}:43183/r/`);
  await mobile.screenshot({ path: test.info().outputPath('pc-mobile.png') });

  // The PC still shows its own document.
  await expect(page.getByRole('heading', { name: 'PCで見ている文書' }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get('document')).toBe(other);
  await mobile.context().close();
});

test('Lane 2: 320 x 568 list with a long title, then document, back, and forward', async ({
  browser,
}) => {
  const title = 'とても長い題名の文書でスマホの狭い画面でも折り返して最後まで読めることを確かめる';
  t.write('long.md', `# ${title}\n\n本文\n`);
  t.write('short.md', '# 短い\n');
  await t.json(['open', 'long.md', 'short.md', '--no-open']);
  const mobile = await phone(browser, { width: 320, height: 568 });
  await mobile.goto(MOBILE_UI_URL);
  const row = list(mobile).getByRole('button', { name: title });
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  await row.tap();
  await expect(mobile.getByTestId('markdown-body')).toContainText('本文');
  const back = mobile.getByRole('button', { name: 'Back to the documents' });
  await expect(back).toBeInViewport();
  await mobile.screenshot({ path: test.info().outputPath('narrow-list.png') });
  await mobile.goBack();
  await expect(list(mobile)).toBeVisible();
  await mobile.goForward();
  await expect(mobile.getByTestId('markdown-body')).toContainText('本文');
  await mobile.goBack();
  await expect(list(mobile)).toBeVisible();

  // From the body, the drawer switches to another document; Back returns to the previous one, and the list button
  // (separate from the drawer) still goes to the list.
  await row.tap();
  await expect(mobile.getByTestId('markdown-body')).toContainText('本文');
  const toggle = mobile.getByRole('button', { name: 'Switch document' });
  await expect(toggle).toBeInViewport();
  await toggle.tap();
  const drawer = mobile.locator('#mobile-document-list');
  await expect(drawer.getByRole('button', { name: title })).toHaveAttribute('aria-current', 'page');
  const drawerBox = await drawer.boundingBox();
  expect((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0)).toBeLessThanOrEqual(320);
  await mobile.screenshot({ path: test.info().outputPath('narrow-drawer.png') });
  await drawer.getByRole('button', { name: '短い' }).tap();
  await expect(mobile.getByRole('heading', { level: 1 })).toHaveText('短い');
  await expect(drawer).toBeHidden();
  await mobile.goBack();
  await expect(mobile.getByTestId('markdown-body')).toContainText('本文');
  await mobile.getByRole('button', { name: 'Back to the documents' }).tap();
  await expect(list(mobile)).toBeVisible();
  await mobile.context().close();
});

test('standalone images on the phone use the shared image view, including an undecodable one', async ({
  browser,
}) => {
  t.write('pic.png', readFileSync(new URL('../fixtures/images/sample.png', import.meta.url)));
  t.write('broken.png', 'not an image');
  await t.json(['open', 'pic.png', 'broken.png', '--no-open']);
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'pic.png' }).tap();
  const image = mobile.getByTestId('document-image');
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  expect(await image.getAttribute('src')).toContain(`https://${MOBILE_HOST}:43183/r/`);
  await mobile.getByRole('button', { name: 'Back to the documents' }).tap();
  await list(mobile).getByRole('button', { name: 'broken.png' }).tap();
  await expect(mobile.getByRole('alert')).toContainText('This browser could not display the image');
  await mobile.context().close();
});

test('Lane 3: 844 x 390 landscape, the demo slider moves', async ({ browser }) => {
  writeDemo();
  t.write(
    'scroll.md',
    `# 長い本文\n\n${Array.from({ length: 80 }, (_, i) => `段落 ${String(i + 1)}`).join('\n\n')}\n`,
  );
  await t.json(['open', 'scroll.md', '--no-open']);
  await openDemo();
  const mobile = await phone(browser, { width: 844, height: 390 });
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'デモ' }).tap();
  const slider = frameOf(mobile).getByRole('slider', { name: '量' });
  await expect(slider).toBeVisible();
  // A real pointer drag along the slider, from its start to its end.
  const box = await slider.boundingBox();
  if (!box) throw new Error('the slider is not on screen');
  await mobile.mouse.move(box.x + 2, box.y + box.height / 2);
  await mobile.mouse.down();
  await mobile.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await mobile.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await mobile.mouse.up();
  await expect(frameOf(mobile).locator('#level')).toHaveText('10');
  await mobile.screenshot({ path: test.info().outputPath('landscape-demo.png') });
  // The body scrolls in landscape too.
  await mobile.getByRole('button', { name: 'Back to the documents' }).tap();
  await list(mobile).getByRole('button', { name: '長い本文' }).tap();
  const body = mobile.locator('main').filter({ has: mobile.getByTestId('markdown-body') });
  await expect(mobile.getByTestId('markdown-body')).toContainText('段落 1');
  await scrollOver(mobile, body, body, 600);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await mobile.context().close();
});

test('Lane 5: a link to an open document opens it on the phone only; an unregistered one says to open it on the PC', async ({
  page,
  browser,
}) => {
  t.write('a.md', '# 文書A\n\n[文書Bへ](b.md)\n\n[文書Cへ](c.md)\n');
  t.write('b.md', '# 文書B\n');
  t.write('c.md', '# 文書C\n');
  await t.json(['open', 'a.md', 'b.md', '--no-open']);
  const status = async () =>
    ((await (await fetch(`${await t.uiUrl()}_/api/v1/status`)).json()) as { data: unknown }).data;
  await page.goto(await t.uiUrl());
  const before = await status();
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: '文書A' }).click();
  // Links to local documents are buttons: nothing navigates; the phone asks which open document it is.
  await mobile.getByRole('button', { name: '文書Cへ' }).click();
  await expect(mobile.getByRole('status')).toHaveText(
    'Open this document on the PC to read it here.',
  );
  await mobile.getByRole('button', { name: '文書Bへ' }).click();
  await expect(mobile.getByRole('heading', { name: '文書B' }).first()).toBeVisible();
  await mobile.screenshot({ path: test.info().outputPath('local-link.png') });
  expect(await status()).toEqual(before);
  expect((await t.json<{ documents: unknown[] }>(['list'])).documents).toHaveLength(2);
  await mobile.context().close();
});

test('Lane 6: other PC activity keeps the demo state; saving the demo shows the new revision from its start', async ({
  browser,
}) => {
  writeDemo();
  await openDemo();
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'デモ' }).click();
  await frameOf(mobile).getByRole('button', { name: '系列B' }).click();
  await expect(frameOf(mobile).locator('#value')).toHaveText('b:4,5,6');
  t.write('else.md', '# 別の文書\n');
  // Opening another document and focusing it on the PC.
  await t.json(['open', 'else.md', '--no-open', '--focus']);
  await expect(list(mobile)).toHaveCount(0);
  await mobile.waitForTimeout(500);
  await expect(frameOf(mobile).locator('#value')).toHaveText('b:4,5,6');
  // Saving the demo itself: a new revision, shown from its start.
  writeFileSync(join(t.work, 'demo.html'), DEMO.replace('loading', 'loading v2'));
  // The file watch picks up the save; it is not waited for here.
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  await mobile.screenshot({ path: test.info().outputPath('document-change.png') });
  await mobile.context().close();
});

test('Lane 7: revoking and allowing again on the PC drops the old frame; only the new view runs', async ({
  browser,
}) => {
  writeDemo();
  await openDemo();
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'デモ' }).click();
  const frame = mobile.getByTestId('document-frame');
  await expect(frame).toHaveAttribute('data-mode', 'interactive');
  const first = await frame.getAttribute('src');
  await t.json(['open', 'demo.html', '--no-open', '--html-mode', 'static']);
  await expect(frame).toHaveAttribute('data-mode', 'static');
  await openDemo();
  await expect(frame).toHaveAttribute('data-mode', 'interactive');
  const again = await frame.getAttribute('src');
  expect(again).not.toBe(first);
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  // The old view's URL is gone.
  const status = await mobile
    .evaluate(async (url) => (await fetch(url ?? '')).status, first)
    .catch(() => 'blocked');
  expect(status).not.toBe(200);
  await mobile.screenshot({ path: test.info().outputPath('lock-epoch.png') });
  await mobile.context().close();
});

test('Lane 8: a daemon restart brings back the phone HTML (Static until allowed again) and the PC image on fixed URLs', async ({
  page,
  browser,
}) => {
  // Fixed PC ports for this home (the phone's public ports are fixed already).
  const free = async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  };
  settings({ managementPort: await free(), previewPort: await free() });
  t.write('pic.png', readFileSync(new URL('../fixtures/images/sample.png', import.meta.url)));
  writeDemo();
  await t.json(['open', 'pic.png', '--no-open']);
  await openDemo();
  const uiUrl = await t.uiUrl();
  const { documents } = await t.json<{ documents: Array<{ documentId: string; title: string }> }>([
    'list',
  ]);
  await page.goto(
    `${uiUrl}?document=${documents.find((d) => d.title === 'pic.png')?.documentId ?? ''}`,
  );
  const pcImage = page.getByRole('img', { name: 'pic.png', exact: true });
  await expect
    .poll(() => pcImage.evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
    .toBe(true);
  const pcBefore = await pcImage.getAttribute('src');

  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'デモ' }).click();
  await expect(mobile.getByTestId('document-frame')).toHaveAttribute('data-mode', 'interactive');

  await t.json(['daemon', 'restart']);
  expect(await t.uiUrl()).toBe(uiUrl);
  await expect(mobile.getByTestId('document-frame')).toHaveAttribute('data-mode', 'static', {
    timeout: 15_000,
  });
  await expect(frameOf(mobile).locator('#value')).toHaveText('loading');
  await expect
    .poll(
      async () =>
        (await pcImage.getAttribute('src')) !== pcBefore &&
        (await pcImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)),
      { timeout: 15_000 },
    )
    .toBe(true);
  await mobile.screenshot({ path: test.info().outputPath('restart-tabs.png') });
  // Allowing again on the PC runs the demo on the phone again.
  await openDemo();
  await expect(mobile.getByTestId('document-frame')).toHaveAttribute('data-mode', 'interactive');
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  await mobile.context().close();
});

test('Lane 9: a document closed on the PC sends the phone back to the list, and its demo cannot be used', async ({
  browser,
}) => {
  writeDemo();
  t.write('next.md', '# 次の文書\n');
  await openDemo();
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'デモ' }).click();
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  await t.json(['close', 'demo.html']);
  await t.json(['open', 'next.md', '--no-open']);
  await expect(mobile.getByRole('status')).toHaveText('That document is no longer open on the PC.');
  await expect(mobile.getByTestId('document-frame')).toHaveCount(0);
  await expect(titles(mobile)).toHaveText(['次の文書']);
  await expect.poll(() => new URL(mobile.url()).searchParams.get('document')).toBeNull();
  await mobile.screenshot({ path: test.info().outputPath('bfcache-close.png') });
  await mobile.context().close();
});

test('only the configured person gets the screen', async ({ browser, browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'The server decides from the proxy headers, not the browser.',
  );
  t.write('a.md', '# a\n');
  await t.json(['open', 'a.md', '--no-open']);
  proxy.identity = 'other';
  const mobile = await phone(browser);
  const response = await mobile.goto(MOBILE_UI_URL);
  expect(response?.status()).toBe(403);
  proxy.identity = 'none';
  expect((await mobile.goto(MOBILE_UI_URL))?.status()).toBe(403);
  proxy.identity = 'person';
  expect((await mobile.goto(MOBILE_UI_URL))?.status()).toBe(200);
  await expect(mobile.getByText('No documents are open on the PC.')).toHaveCount(0);
  await mobile.context().close();
});

test('opened from the home screen, pulling down from the top reloads the reader', async ({
  browser,
}) => {
  // Real touch input through CDP: Chromium only.
  test.skip(browser.browserType().name() !== 'chromium', 'touch drags need CDP');
  t.write('a.md', '# a\n');
  await t.json(['open', 'a.md', '--no-open']);
  const mobile = await phone(browser);
  await mobile.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
  });
  await mobile.goto(MOBILE_UI_URL);
  await expect(titles(mobile)).toHaveText(['a']);
  await mobile.evaluate(() => {
    (window as Window & { beforeReload?: boolean }).beforeReload = true;
  });
  const cdp = await mobile.context().newCDPSession(mobile);
  const drag = async (to: number) => {
    const at = (y: number) => [{ x: 200, y }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(80) });
    for (let y = 80; y <= to; y += 20) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(y) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const reloaded = () =>
    mobile.evaluate(() => (window as Window & { beforeReload?: boolean }).beforeReload !== true);
  // A short pull does nothing.
  await drag(120);
  expect(await reloaded()).toBe(false);
  const load = mobile.waitForEvent('load');
  await drag(240);
  await load;
  expect(await reloaded()).toBe(true);
  await expect(titles(mobile)).toHaveText(['a']);
  await mobile.context().close();
});

test('a return with the list held back keeps the demo stopped, then drops a frame revoked meanwhile', async ({
  browser,
}) => {
  writeDemo();
  await openDemo();
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: 'デモ' }).click();
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  await expect(mobile.getByTestId('frame-paused')).toHaveCount(0);

  // Hold the list back, then come back to the page (as from the lock screen or the history cache).
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mobile.route('**/_/mobile/v1/documents*', async (route) => {
    await held;
    await route.continue();
  });
  await mobile.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(mobile.getByTestId('frame-paused')).toHaveCount(1);
  await expect(mobile.getByTestId('document-frame')).toHaveAttribute('inert', '');
  // Meanwhile the PC revokes the permission. A real tap on the demo does not reach it.
  await t.json(['open', 'demo.html', '--no-open', '--html-mode', 'static']);
  const button = await frameOf(mobile).getByRole('button', { name: '系列B' }).boundingBox();
  if (!button) throw new Error('the demo button is not on screen');
  await mobile.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await expect(frameOf(mobile).locator('#value')).toHaveText('a:1,2,3');
  release();
  // The list arrives: the revoked view is dropped and the new one does not run scripts.
  await expect(mobile.getByTestId('document-frame')).toHaveAttribute('data-mode', 'static');
  await expect(frameOf(mobile).locator('#value')).toHaveText('loading');
  await mobile.context().close();
});

test('a static view stays scrollable while it is checked again, and its document links wait for the check', async ({
  browser,
}) => {
  t.write(
    'page.html',
    `<!doctype html><html><head><title>静的な文書</title></head><body>${Array.from({ length: 80 }, (_, i) => `<p>段落 ${String(i + 1)}</p>`).join('')}<p><a href="b.md">文書Bへ</a></p></body></html>`,
  );
  t.write('b.md', '# 文書B\n');
  await t.json(['open', 'page.html', 'b.md', '--no-open']);
  const mobile = await phone(browser);
  await mobile.goto(MOBILE_UI_URL);
  await list(mobile).getByRole('button', { name: '静的な文書' }).tap();
  const frame = mobile.getByTestId('document-frame');
  await expect(frame).toHaveAttribute('data-mode', 'static');
  await expect(frameOf(mobile).getByText('段落 1', { exact: true })).toBeVisible();

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mobile.route('**/_/mobile/v1/documents*', async (route) => {
    await held;
    await route.continue();
  });
  await mobile.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(mobile.getByTestId('frame-paused')).toHaveCount(0);
  await expect(frame).not.toHaveAttribute('inert', '');
  await scrollOver(mobile, frame, frameOf(mobile).locator('body'), 800);
  await expect
    .poll(() =>
      frameOf(mobile)
        .locator('body')
        .evaluate(() => window.scrollY),
    )
    .toBeGreaterThan(0);
  // A link tapped before the check is done is not followed.
  const url = mobile.url();
  await frameOf(mobile).getByText('文書Bへ').click();
  await mobile.waitForTimeout(300);
  expect(mobile.url()).toBe(url);
  const answered = mobile.waitForResponse('**/_/mobile/v1/render-grants/check');
  release();
  await answered;
  await frameOf(mobile).getByText('文書Bへ').click();
  await expect(mobile.getByRole('heading', { name: '文書B' }).first()).toBeVisible();
  await mobile.context().close();
});

test('both screens declare an icon and a home-screen icon that load', async ({
  page,
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'The icons are fetched with the request API, not the browser.',
  );
  t.write('a.md', '# a\n');
  await t.json(['open', 'a.md', '--no-open']);
  const mobile = await phone(browser);
  for (const [target, url] of [
    [page, await t.uiUrl()],
    [mobile, MOBILE_UI_URL],
  ] as const) {
    await target.goto(url);
    for (const [rel, type] of [
      ['icon', 'image/svg+xml'],
      ['apple-touch-icon', 'image/png'],
    ] as const) {
      const href = await target.locator(`link[rel="${rel}"]`).getAttribute('href');
      expect(href).toMatch(/^\/assets\//);
      const response = await target.request.get(new URL(href ?? '', url).toString());
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe(type);
    }
  }
  await mobile.context().close();
});

// Styles or scripts the phone screen's CSP blocked, recorded from the first load.
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const blocked: string[] = [];
    (window as unknown as { blocked: string[] }).blocked = blocked;
    document.addEventListener('securitypolicyviolation', (event) => {
      blocked.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { blocked: string[] }).blocked);
}

// A held press, released after the menu opened. Chromium holds a real touch (the release lands on the row, as on a
// phone); Playwright has no touch hold for WebKit, so a mouse button holds there.
async function longPress(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('the row is not on screen');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (test.info().project.name === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await expect(page.getByRole('dialog')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.mouse.up();
}

test('a long press offers the details and removing the document from the PC list, as the PC close button does', async ({
  browser,
}) => {
  t.write('a.md', '# 文書A\n');
  t.write('b.md', '# 文書B\n');
  await t.json(['open', 'a.md', 'b.md', '--no-open']);
  const mobile = await phone(browser);
  const blocked = await watchCsp(mobile);
  await mobile.goto(MOBILE_UI_URL);
  const row = list(mobile).getByRole('button', { name: '文書A' });

  await longPress(mobile, row);
  const sheet = mobile.getByRole('dialog');
  // The release does not also open the document behind the sheet.
  await expect(sheet.getByRole('button', { name: 'Remove from the PC list' })).toBeVisible();
  expect(new URL(mobile.url()).searchParams.get('document')).toBeNull();
  await mobile.screenshot({ path: test.info().outputPath('long-press-sheet.png') });
  await sheet.getByRole('button', { name: 'Details' }).tap();
  // The menu gives way to the details.
  await expect(mobile.getByText('Remove from the PC list')).toHaveCount(0);
  await expect(sheet.getByRole('heading', { name: '文書A' })).toBeVisible();
  // The menu finished leaving without taking focus out of the details.
  await expect
    .poll(() => mobile.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
    .toBe(true);
  await expect(sheet).toContainText('a.md');
  await expect(sheet).not.toContainText(realpathSync(t.work));
  await mobile.screenshot({ path: test.info().outputPath('details.png') });
  await sheet.getByRole('button', { name: 'Close' }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();

  await longPress(mobile, row);
  await sheet.getByRole('button', { name: 'Remove from the PC list' }).tap();
  await expect(titles(mobile)).toHaveText(['文書B']);
  const { documents } = await t.json<{ documents: Array<{ title: string }> }>(['list']);
  expect(documents.map((document) => document.title)).toEqual(['文書B']);
  expect(await blocked()).toEqual([]);
  await mobile.context().close();
});
