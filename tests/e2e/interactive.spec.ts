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
  revision: string;
  status: string;
  submission: null | {
    submissionId: string;
    answers: Record<string, unknown>;
    revision: string;
    confirmedAgainstOlderRevision: boolean;
  };
}

const questionnaire = {
  schemaVersion: 1,
  title: 'ログイン画面の確認',
  fieldOrder: ['layout', 'density'],
  answerSchema: {
    type: 'object',
    properties: {
      layout: { type: 'string', title: '採用案', enum: ['A', 'B'] },
      density: { type: 'string', title: '表示密度', enum: ['comfortable', 'compact'] },
    },
    required: ['layout', 'density'],
    additionalProperties: false,
  },
};

// The element the document's script writes its result into.
const page = (body: string, script: string) =>
  `<!doctype html><html><head><title>確認用のHTML</title></head><body><p id="state">waiting</p>${body}<script>${script}</script></body></html>`;

const frameOf = (target: Page) => target.frameLocator('[data-testid="document-frame"]');
const panelOf = (target: Page) =>
  target.getByRole('complementary', { name: 'Answer the question' });

async function askInteractive(html: string, extra: string[] = []): Promise<Request> {
  t.write('q.json', JSON.stringify(questionnaire));
  t.write('review.html', html);
  const { request } = await t.json<{ request: Request }>([
    'ask',
    'q.json',
    '--view',
    'review.html',
    '--html-mode',
    'interactive',
    ...extra,
  ]);
  return request;
}

test('FB-007: a draft saved with updateDraft from the HTML is submitted from the UI, and the CLI wait receives the same content', async ({
  page: ui,
}) => {
  const request = await askInteractive(
    page(
      '<button id="apply" type="button">回答案を反映</button>',
      `const state = document.getElementById('state');
      let base = null;
      vde.ready().then(
        (info) => { base = info.draftVersion; state.textContent = 'ready ' + info.draftVersion + ' ' + info.questionnaire.title; },
        (error) => { state.textContent = 'error ' + error.code; },
      );
      document.getElementById('apply').addEventListener('click', () => {
        vde.feedback.updateDraft({ layout: 'B', density: 'compact' }, { baseDraftVersion: base }).then(
          (result) => { base = result.draftVersion; state.textContent = 'saved ' + result.draftVersion; },
          (error) => { state.textContent = 'error ' + error.code; },
        );
      });`,
    ),
  );
  await ui.goto(await t.uiUrl());
  const frame = frameOf(ui);
  await expect(ui.getByTestId('html-mode')).toHaveText('Scripts running');
  await expect(frame.locator('#state')).toHaveText('ready 0 ログイン画面の確認');
  await expect(ui.getByTestId('bridge-status')).toContainText('Drafts linked (not sent)');

  await frame.locator('#apply').click();
  await expect(frame.locator('#state')).toHaveText('saved 1');
  const panel = panelOf(ui);
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  await expect(panel.getByRole('definition')).toHaveText(['B', 'compact']);
  // The HTML's "apply draft" button is not a substitute for submitting.
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  const waiting = t.json<Request>(['feedback', 'wait', request.requestId, '--timeout', '20']);
  await panel.getByRole('button', { name: 'Send answers to the agent' }).click();
  const answered = await waiting;
  expect(answered).toMatchObject({
    requestId: request.requestId,
    status: 'submitted',
    revision: request.revision,
    submission: {
      answers: { layout: 'B', density: 'compact' },
      revision: request.revision,
      confirmedAgainstOlderRevision: false,
    },
  });
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).submission).toEqual(
    answered.submission,
  );
});

// The document's script grabs the port handed over by the UI, bypassing the SDK (code inside the HTML is not trusted).
const GRAB_PORT = `function onPort(handler) {
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'vde-bridge-port' && event.ports.length === 1) {
      handler(event.ports[0], event.data.instanceId);
    }
  });
}`;

test('FB-009: the port is handed to the shown iframe only once; requests from another window and after a reload get no port', async ({
  page: ui,
}) => {
  t.write('first.md', '# First\n');
  const opened = await t.json<{ documents: Array<{ documentId: string }> }>(['open', 'first.md']);
  const request = await askInteractive(
    page(
      '',
      `const state = document.getElementById('state');
      let ports = 0;
      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'vde-bridge-port') ports += 1;
      });
      vde.ready().then(
        (info) => { state.textContent = 'ready ' + info.draftVersion + ' ports ' + ports; },
        (error) => { state.textContent = 'error ' + error.code; },
      );
      window.reportPorts = () => { state.textContent = 'ports ' + ports; };
      document.addEventListener('click', () => { location.reload(); });`,
    ),
  );
  // The render grant with the SDK injected into the HTML (issued after the question is fetched).
  const granted = ui.waitForResponse(
    async (response) =>
      response.url().endsWith('/render-grants') &&
      ((await response.json()) as { data?: { bridge?: unknown } }).data?.bridge != null,
  );
  const url = new URL(await t.uiUrl());
  url.searchParams.set('document', opened.documents[0]!.documentId);
  await ui.goto(url.href);
  await expect(ui.locator('article')).toHaveText('First');
  await ui
    .getByRole('navigation', { name: 'Open documents' })
    .locator(`button[data-document-id="${request.documentId}"]`)
    .click();
  const grant = (await (await granted).json()) as { data: { bridge: { instanceId: string } } };
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0 ports 1');

  // Even if the management UI window itself asks to start communication with the same identifier, no port is handed over.
  const portsToTop = await ui.evaluate(async (instanceId) => {
    let received = 0;
    window.addEventListener('message', (event) => {
      if ((event.data as { type?: string } | null)?.type === 'vde-bridge-port') received += 1;
    });
    window.postMessage({ type: 'vde-bridge-hello', protocolVersion: 1, instanceId }, '*');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return received;
  }, grant.data.bridge.instanceId);
  expect(portsToTop).toBe(0);
  await frame.locator('body').evaluate(() => {
    (window as unknown as { reportPorts: () => void }).reportPorts();
  });
  await expect(frame.locator('#state')).toHaveText('ports 1');

  // When the document reloads itself, the communication ends. The reloaded document keeps asking and gets no port.
  await ui.evaluate(() => {
    const top = window as unknown as { hellos: number };
    top.hellos = 0;
    window.addEventListener('message', (event) => {
      if ((event.data as { type?: string } | null)?.type === 'vde-bridge-hello') top.hellos += 1;
    });
  });
  await frame.locator('body').click();
  await expect(ui.getByTestId('bridge-status')).toContainText('View reloaded');
  await expect
    .poll(() => ui.evaluate(() => (window as unknown as { hellos: number }).hellos))
    .toBeGreaterThanOrEqual(3);
  await frame.locator('body').evaluate(() => {
    (window as unknown as { reportPorts: () => void }).reportPorts();
  });
  await expect(frame.locator('#state')).toHaveText('ports 0');
  // Reloading the view starts communication as a new view.
  await ui.getByRole('button', { name: 'Reload view' }).click();
  await expect(frame.locator('#state')).toHaveText('ready 0 ports 1');
});

test('FB-010: a malformed frame ends the communication, and the management UI and daemon keep working', async ({
  page: ui,
}) => {
  const request = await askInteractive(
    page(
      '',
      `${GRAB_PORT}
      const state = document.getElementById('state');
      onPort((port) => {
        port.postMessage('not a frame');
        setTimeout(() => {
          vde.ready().then(() => { state.textContent = 'still open'; }, (error) => { state.textContent = 'closed ' + error.code; });
        }, 300);
      });`,
    ),
  );
  await ui.goto(await t.uiUrl());
  await expect(ui.getByTestId('bridge-status')).toContainText('Invalid draft message');
  await expect(frameOf(ui).locator('#state')).toHaveText('closed E_BRIDGE_CLOSED');
  // Answering from the management UI still works. The daemon still responds.
  const panel = panelOf(ui);
  await panel.getByRole('radio', { name: 'B', exact: true }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');
});

test('FB-011: even after learning of another window update, a draft the HTML sends based on an old version conflicts and does not overwrite', async ({
  page: first,
  context,
}) => {
  await askInteractive(
    page(
      '<button id="stale" type="button">古い版で反映</button><p id="changes"></p>',
      `const state = document.getElementById('state');
      let base = null;
      vde.ready().then((info) => { base = info.draftVersion; state.textContent = 'ready ' + base; });
      vde.feedback.onDraftChanged((draft) => {
        document.getElementById('changes').textContent = 'changed ' + draft.draftVersion + ' ' + draft.answers.layout;
      });
      document.getElementById('stale').addEventListener('click', () => {
        // Base on the version first received, not the newer one that was reported. The SDK does not reinterpret versions.
        vde.feedback.updateDraft({ layout: 'A', density: 'comfortable' }, { baseDraftVersion: base }).then(
          (result) => { state.textContent = 'saved ' + result.draftVersion; },
          (error) => { state.textContent = 'error ' + error.code; },
        );
      });`,
    ),
  );
  await first.goto(await t.uiUrl());
  const frame = frameOf(first);
  await expect(frame.locator('#state')).toHaveText('ready 0');

  // Another window saves a draft.
  const second = await context.newPage();
  await second.goto(await t.uiUrl());
  const otherPanel = panelOf(second);
  // The second window also renders without waiting on the notification connection (the browser cache does not block a connection to the same URL).
  await expect(otherPanel).toBeVisible({ timeout: 5000 });
  await otherPanel.getByRole('radio', { name: 'B', exact: true }).click();
  await otherPanel.getByRole('radio', { name: 'compact', exact: true }).click();
  await expect(otherPanel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  await expect(frame.locator('#changes')).toHaveText(/^changed \d+ B$/);

  await frame.locator('#stale').click();
  await expect(frame.locator('#state')).toHaveText('error E_DRAFT_CONFLICT');
  await expect(panelOf(first).getByRole('definition')).toHaveText(['B', 'compact']);
});

test("FB-015 / FB-016: even if the HTML and CSS are updated during the question, the question's revision is shown, and the SDK offers no older-revision confirmation", async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Which revision the question view pins and what the SDK exposes are app logic, with nothing engine-specific.',
  );
  t.write('style.css', 'p { color: rgb(0, 0, 255); }');
  const request = await askInteractive(
    `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p id="state">版1</p><script>
      document.getElementById('state').textContent = '版1 ' + Object.keys(vde.feedback).sort().join(',') + ' ' + typeof vde.confirmOlderRevision;
    </script></body></html>`,
  );
  await ui.goto(await t.uiUrl());
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('版1 onDraftChanged,updateDraft undefined');

  t.atomicWrite('style.css', 'p { color: rgb(255, 0, 0); }');
  const panel = panelOf(ui);
  await expect(panel.getByRole('alert')).toContainText('A newer revision is available');
  t.atomicWrite('review.html', '<!doctype html><html><body><p id="state">版3</p></body></html>');
  await expect
    .poll(async () => (await t.json<{ revision: string }>(['read', request.documentId])).revision)
    .not.toBe(request.revision);
  // The view being answered is not replaced with the new revision.
  await expect(frame.locator('#state')).toHaveText(/^版1 /);
  await expect(frame.locator('#state')).toHaveCSS('color', 'rgb(0, 0, 255)');
});

test('FB-022: after a daemon restart, scripts stay off until allowed again, and once allowed the HTML can send drafts to the pending question', async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Losing the permission on restart and allowing it again is daemon and UI logic; FB-007 covers starting the communication in every browser.',
  );
  const request = await askInteractive(
    page(
      '<button id="apply" type="button">回答案を反映</button>',
      `const state = document.getElementById('state');
      if (typeof window.vde === 'undefined') state.textContent = 'no sdk';
      else vde.ready().then((info) => { state.textContent = 'ready ' + info.requestId; });
      document.getElementById('apply').addEventListener('click', () => {
        vde.feedback.updateDraft({ layout: 'A' }, { baseDraftVersion: 0 }).then(
          () => { state.textContent = 'saved'; },
          (error) => { state.textContent = 'error ' + error.code; },
        );
      });`,
    ),
  );
  await ui.goto(await t.uiUrl());
  const before = frameOf(ui);
  await expect(before.locator('#state')).toHaveText(`ready ${request.requestId}`);

  expect((await t.run(['daemon', 'restart', '--json'])).exitCode).toBe(0);
  // The port from the window before the restart cannot change the draft (the old view is unusable).
  await before.locator('#apply').click();
  await expect(before.locator('#state')).toHaveText(/^error /);

  await ui.goto(await t.uiUrl());
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('Not answered');
  await expect(ui.getByTestId('html-mode')).toHaveText('Scripts off');
  await expect(ui.getByTestId('document-frame')).toHaveAttribute('sandbox', '');
  // Scripts do not run in the Static view.
  await expect(frameOf(ui).locator('#state')).toHaveText('waiting');
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  await ui.getByRole('button', { name: 'Run scripts…' }).click();
  await ui.getByRole('button', { name: 'Run scripts', exact: true }).click();
  await expect(ui.getByTestId('html-mode')).toHaveText('Scripts running');
  await expect(frameOf(ui).locator('#state')).toHaveText(`ready ${request.requestId}`);
});

test('SEC-004: even in the Interactive view, the management UI DOM, sessionStorage, cookies, and management API are unreachable', async ({
  page: ui,
}) => {
  t.write('dummy.md', '# dummy\n');
  await t.json(['open', 'dummy.md']);
  const management = new URL(await t.uiUrl()).origin;
  t.write(
    'probe.html',
    page(
      '',
      `const state = document.getElementById('state');
      const results = {};
      const attempt = (name, action) => { try { action(); results[name] = 'readable'; } catch (error) { results[name] = 'blocked'; } };
      attempt('parentDocument', () => window.parent.document.title);
      attempt('sessionStorage', () => window.sessionStorage.length);
      attempt('localStorage', () => window.localStorage.length);
      attempt('cookie', () => document.cookie);
      fetch(${JSON.stringify(management)} + '/_/api/v1/status').then(
        () => 'reachable',
        () => 'blocked',
      ).then((api) => { results.api = api; state.textContent = JSON.stringify(results); });`,
    ),
  );
  await t.json(['open', 'probe.html', '--html-mode', 'interactive', '--focus']);
  await ui.goto(await t.uiUrl());
  await expect(frameOf(ui).locator('#state')).toHaveText(
    JSON.stringify({
      parentDocument: 'blocked',
      sessionStorage: 'blocked',
      localStorage: 'blocked',
      cookie: 'blocked',
      api: 'blocked',
    }),
  );
  await expect(ui.getByTestId('document-frame')).toHaveAttribute('sandbox', 'allow-scripts');
});

test('SEC-007 / SEC-013: registered JSON and modules load by relative reference, unregistered files are 404 and reported as missing, and the management API and external hosts are unreachable', async ({
  page: ui,
}) => {
  t.write('dummy.md', '# dummy\n');
  await t.json(['open', 'dummy.md']);
  const management = new URL(await t.uiUrl()).origin;
  t.write('data.json', JSON.stringify({ message: '登録したJSON' }));
  t.write('mod.js', "export const message = '登録したmodule';");
  t.write('unregistered.json', JSON.stringify({ message: '未登録' }));
  t.write(
    'app.html',
    `<!doctype html><html><body>
    <p id="data">waiting</p><p id="module">waiting</p><p id="missing">waiting</p><p id="missing-module">waiting</p><p id="network">waiting</p>
    <script>
      const show = (id, text) => { document.getElementById(id).textContent = text; };
      const violations = [];
      document.addEventListener('securitypolicyviolation', (event) => { violations.push(event.violatedDirective); });
      fetch('./data.json').then((response) => response.json()).then((data) => show('data', data.message), () => show('data', 'failed'));
      fetch('./unregistered.json').then((response) => show('missing', String(response.status)), () => show('missing', 'failed'));
      Promise.all([
        fetch(${JSON.stringify(management)} + '/_/api/v1/status').then(() => 'reachable', () => 'blocked'),
        fetch('https://example.com/').then(() => 'reachable', () => 'blocked'),
      ]).then((results) => {
        setTimeout(() => show('network', results.join(',') + ' ' + [...new Set(violations)].sort().join(',')), 100);
      });
    </script>
    <script type="module">
      import { message } from './mod.js';
      document.getElementById('module').textContent = message;
      import('./missing.js').then(() => { document.getElementById('missing-module').textContent = 'loaded'; }, () => { document.getElementById('missing-module').textContent = 'failed'; });
    </script></body></html>`,
  );
  await t.json([
    'open',
    'app.html',
    '--html-mode',
    'interactive',
    '--assets-root',
    '.',
    '--asset',
    'data.json',
    '--asset',
    'mod.js',
    '--focus',
  ]);
  await ui.goto(await t.uiUrl());
  await ui
    .getByRole('navigation', { name: 'Open documents' })
    .getByRole('button', { name: 'app.html', exact: true })
    .click();
  const frame = frameOf(ui);
  await expect(frame.locator('#data')).toHaveText('登録したJSON');
  await expect(frame.locator('#module')).toHaveText('登録したmodule');
  // Unregistered files are not served even if they are in the same directory.
  await expect(frame.locator('#missing')).toHaveText('failed');
  await expect(frame.locator('#missing-module')).toHaveText('failed');
  await expect(frame.locator('#network')).toHaveText('blocked,blocked connect-src');
  const src = await ui.getByTestId('document-frame').getAttribute('src');
  expect((await fetch(new URL('unregistered.json', src ?? '')).catch(() => null))?.status).toBe(
    404,
  );

  // The files that could not be loaded, and how to register them, are shown in the UI.
  await ui.getByTestId('render-diagnostics').click();
  const diagnostics = ui.getByRole('dialog', { name: 'Differences from the original document' });
  await expect(diagnostics).toContainText('The view tried to load unregistered.json');
  await expect(diagnostics).toContainText('The view tried to load missing.js');
  await expect(diagnostics).toContainText('--asset');
});

test('SEC-008: even in the Interactive view, popups, top navigation, form submission, downloads, and workers are not allowed', async ({
  page: ui,
}) => {
  const downloads: string[] = [];
  ui.on('download', (download) => downloads.push(download.suggestedFilename()));
  t.write(
    'hostile.html',
    page(
      '<form id="form" action="https://example.com/" method="post"><input name="q" value="1"></form>',
      `const state = document.getElementById('state');
      const results = {};
      try { results.popup = window.open('https://example.com/') === null ? 'blocked' : 'opened'; } catch (error) { results.popup = 'blocked'; }
      try { window.top.location.href = 'https://example.com/'; results.top = 'attempted'; } catch (error) { results.top = 'blocked'; }
      try { document.getElementById('form').submit(); results.form = 'attempted'; } catch (error) { results.form = 'blocked'; }
      const link = document.createElement('a');
      link.href = 'data:text/plain,secret';
      link.download = 'secret.txt';
      document.body.append(link);
      link.click();
      const tryWorker = (url) => new Promise((resolve) => {
        try {
          const worker = new Worker(url);
          worker.onmessage = () => resolve('ran');
          worker.onerror = () => resolve('blocked');
          setTimeout(() => resolve('blocked'), 1000);
        } catch (error) { resolve('blocked'); }
      });
      Promise.all([
        tryWorker('data:text/javascript,postMessage(1)'),
        tryWorker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))),
      ]).then(([dataWorker, blobWorker]) => {
        results.dataWorker = dataWorker;
        results.blobWorker = blobWorker;
        state.textContent = JSON.stringify(results);
      });`,
    ),
  );
  await t.json(['open', 'hostile.html', '--html-mode', 'interactive']);
  const before = await t.uiUrl();
  await ui.goto(before);
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toContainText('"dataWorker":"blocked"');
  const results = JSON.parse((await frame.locator('#state').textContent()) ?? '{}') as Record<
    string,
    string
  >;
  expect(results).toMatchObject({ popup: 'blocked', dataWorker: 'blocked', blobWorker: 'blocked' });
  // The top window did not navigate. No form submission or download happened (the document is unchanged).
  expect(new URL(ui.url()).origin).toBe(new URL(before).origin);
  expect(ui.context().pages()).toHaveLength(1);
  await ui.waitForTimeout(500);
  expect(downloads).toEqual([]);
  await expect(frame.locator('#form')).toBeAttached();
});

test('FB-003: the SDK ready and updateDraft succeed even when both the questionnaire and the draft are at the maximum size', async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'The frame size budget is plain JS arithmetic, the same in every engine.',
  );
  // A questionnaire close to 64KiB (Japanese instructions and long string fields).
  const fields = Array.from({ length: 5 }, (_, index) => `note${String(index)}`);
  const big = {
    schemaVersion: 1,
    title: '大きな質問',
    instructions: '説'.repeat(4000),
    fieldOrder: fields,
    answerSchema: {
      type: 'object',
      properties: Object.fromEntries(
        fields.map((name) => [
          name,
          { type: 'string', title: name, description: '明'.repeat(1900), maxLength: 4000 },
        ]),
      ),
      required: [],
      additionalProperties: false,
    },
  };
  const questionnaireText = JSON.stringify(big);
  expect(Buffer.byteLength(questionnaireText)).toBeGreaterThan(40 * 1024);
  expect(Buffer.byteLength(questionnaireText)).toBeLessThanOrEqual(64 * 1024);
  t.write('q.json', questionnaireText);
  t.write(
    'review.html',
    page(
      '',
      `const state = document.getElementById('state');
      const answers = {};
      ${JSON.stringify(fields)}.forEach((name) => { answers[name] = '答'.repeat(4000); });
      vde.ready()
        .then((info) => vde.feedback.updateDraft(answers, { baseDraftVersion: info.draftVersion }))
        .then(() => vde.ready())
        .then((info) => {
          state.textContent = 'ok ' + info.questionnaire.instructions.length + ' ' + Object.values(info.answers).map((value) => value.length).join(',');
        }, (error) => { state.textContent = 'error ' + error.code + ' ' + error.message; });`,
    ),
  );
  await t.json(['ask', 'q.json', '--view', 'review.html', '--html-mode', 'interactive']);
  await ui.goto(await t.uiUrl());
  await expect(frameOf(ui).locator('#state')).toHaveText('ok 4000 4000,4000,4000,4000,4000', {
    timeout: 15_000,
  });
});

// Wait for the response of the render grant with the SDK injected into the HTML (the question's view).
const bridgedGrant = (target: Page) =>
  target.waitForResponse(
    async (response) =>
      response.url().endsWith('/render-grants') &&
      ((await response.json()) as { data?: { bridge?: unknown } }).data?.bridge != null,
  );

const APPLY = `const state = document.getElementById('state');
let base = null;
vde.ready().then(
  (info) => { base = info.draftVersion; state.textContent = 'ready ' + info.draftVersion; },
  (error) => { state.textContent = 'error ' + error.code; },
);
document.getElementById('apply').addEventListener('click', () => {
  vde.feedback.updateDraft({ layout: 'B', density: 'compact' }, { baseDraftVersion: base }).then(
    (result) => { base = result.draftVersion; state.textContent = 'saved ' + result.draftVersion; },
    (error) => { state.textContent = 'error ' + error.code; },
  );
});`;

test('FB-009: once the render grant expires, drafts from the HTML are not accepted and the communication ends', async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Expiry is decided by the daemon and the close by the UI; the malformed-frame test covers the port close in every browser.',
  );
  await askInteractive(page('<button id="apply" type="button">反映</button>', APPLY));
  const granted = bridgedGrant(ui);
  await ui.goto(await t.uiUrl());
  const { data } = (await (await granted).json()) as { data: { grant: string } };
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0');

  // Release the grant in use through the management API (the same state as expiry due to the view count limit).
  await ui.evaluate(async (grant) => {
    await fetch('/_/api/v1/render-grants/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grants: [grant] }),
    });
  }, data.grant);
  await frame.locator('#apply').click();
  await expect(frame.locator('#state')).toHaveText(
    /^error E_(RENDER_GRANT_INVALID|BRIDGE_CLOSED)$/,
  );
  await expect(ui.getByTestId('bridge-status')).toContainText('Render permission expired');
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('Not answered');
});

test('FB-009: returning from Source to Preview ends the previous communication and starts a new one as a new view', async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'The frame is rebuilt per URL and connects like a first view, which FB-007 covers in every browser.',
  );
  await askInteractive(page('<button id="apply" type="button">反映</button>', APPLY));
  await ui.goto(await t.uiUrl());
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0');
  const before = await ui.getByTestId('document-frame').getAttribute('src');

  await ui.getByRole('button', { name: 'Source' }).click();
  await expect(ui.getByTestId('document-frame')).toHaveCount(0);
  await expect(ui.getByTestId('bridge-status')).toHaveCount(0);
  await ui.getByRole('button', { name: 'Preview' }).click();
  await expect(frame.locator('#state')).toHaveText('ready 0');
  expect(await ui.getByTestId('document-frame').getAttribute('src')).not.toBe(before);
  await expect(ui.getByTestId('bridge-status')).toContainText('Drafts linked (not sent)');
  await frame.locator('#apply').click();
  await expect(frame.locator('#state')).toHaveText('saved 1');
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('Draft answer saved');
});

test('FB-015: a question created in static mode stays in the Static view until answered, even if the document scripts are allowed later', async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Which grant the question uses is UI and daemon logic; the Static view isolation tests cover the sandbox in every browser.',
  );
  t.write('q.json', JSON.stringify(questionnaire));
  t.write('review.html', page('', "document.getElementById('state').textContent = 'ran';"));
  const { request } = await t.json<{ request: Request }>([
    'ask',
    'q.json',
    '--view',
    'review.html',
  ]);
  await t.json(['open', 'review.html', '--html-mode', 'interactive']);
  await ui.goto(await t.uiUrl());
  await expect(ui.getByTestId('html-mode')).toHaveText('Scripts off for this question');
  await expect(ui.getByTestId('document-frame')).toHaveAttribute('sandbox', '');
  await ui.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(
    ui.getByText('This question was created in the Static view', { exact: false }),
  ).toBeVisible();
  await ui.getByRole('button', { name: 'Close details' }).click();
  await expect(frameOf(ui).locator('#state')).toHaveText('waiting');

  // Once the question ends, the document's own view mode (interactive, already allowed) is used.
  await t.json(['feedback', 'cancel', request.requestId]);
  await expect(ui.getByTestId('html-mode')).toHaveText('Scripts running');
  await expect(frameOf(ui).locator('#state')).toHaveText('ran');
});

test('FB-009: after the render grant expires, the communication ends without reporting other windows drafts, even if the HTML requests nothing', async ({
  page: ui,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Ending the communication on expiry is UI logic; the malformed-frame test covers the port close in every browser.',
  );
  await askInteractive(
    page(
      '<p id="changes"></p>',
      `const state = document.getElementById('state');
      vde.ready().then((info) => { state.textContent = 'ready ' + info.draftVersion; });
      vde.feedback.onDraftChanged((draft) => {
        document.getElementById('changes').textContent = 'changed ' + draft.draftVersion + ' ' + draft.answers.layout;
      });`,
    ),
  );
  const granted = bridgedGrant(ui);
  await ui.goto(await t.uiUrl());
  const { data } = (await (await granted).json()) as { data: { grant: string } };
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0');

  await ui.evaluate(async (grant) => {
    await fetch('/_/api/v1/render-grants/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grants: [grant] }),
    });
  }, data.grant);
  // Only the management UI's answer panel updates the draft.
  const panel = panelOf(ui);
  await panel.getByRole('radio', { name: 'A', exact: true }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('Draft answer saved');
  await expect(ui.getByTestId('bridge-status')).toContainText('Render permission expired');
  await ui.waitForTimeout(500);
  await expect(frame.locator('#changes')).toHaveText('');
});
