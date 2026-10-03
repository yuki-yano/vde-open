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

// 文書の中のscriptが、結果を書き込む要素。
const page = (body: string, script: string) =>
  `<!doctype html><html><head><title>確認用のHTML</title></head><body><p id="state">waiting</p>${body}<script>${script}</script></body></html>`;

const frameOf = (target: Page) => target.frameLocator('[data-testid="document-frame"]');
const panelOf = (target: Page) => target.getByRole('complementary', { name: '質問への回答' });

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

test('FB-007: HTMLのupdateDraftで保存した回答案を、本体で送信し、CLIのwaitで同じ内容を受け取る', async ({
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
  await ui.goto(await t.bootstrapUrl());
  const frame = frameOf(ui);
  await expect(ui.getByTestId('html-mode')).toHaveText('scriptを動かす表示');
  await expect(frame.locator('#state')).toHaveText('ready 0 ログイン画面の確認');
  await expect(ui.getByTestId('bridge-status')).toContainText('回答案を受け付けています');

  await frame.locator('#apply').click();
  await expect(frame.locator('#state')).toHaveText('saved 1');
  const panel = panelOf(ui);
  await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  await expect(panel.getByRole('definition')).toHaveText(['B', 'compact']);
  // HTMLの「回答案を反映」は、送信の代わりにならない。
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  const waiting = t.json<Request>(['feedback', 'wait', request.requestId, '--timeout', '20']);
  await panel.getByRole('button', { name: 'Agentへ回答を送信' }).click();
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

// 文書のscriptが、SDKとは別に、本体から渡されたportを横取りする（HTMLの中のcodeは信頼しない）。
const GRAB_PORT = `function onPort(handler) {
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'vde-bridge-port' && event.ports.length === 1) {
      handler(event.ports[0], event.data.instanceId);
    }
  });
}`;

test('FB-008: HTMLからの送信・取得済みの印・中止・検索・読み取り・旧版の確認は拒否され、質問は回答待ちのまま', async ({
  page: ui,
}) => {
  const request = await askInteractive(
    page(
      '',
      `${GRAB_PORT}
      const state = document.getElementById('state');
      const methods = ['submit', 'ack', 'cancel', 'search', 'read', 'open', 'confirmOlderRevision'];
      onPort((port, instanceId) => {
        const results = [];
        port.addEventListener('message', (reply) => {
          if (reply.data.type !== 'response' || reply.data.sequence < 1000) return;
          results.push(reply.data.ok ? 'ok' : reply.data.error.code);
          if (results.length === methods.length) state.textContent = results.join(',');
        });
        port.start();
        methods.forEach((method, index) => {
          port.postMessage({ protocolVersion: 1, instanceId, sequence: 1000 + index, method, payload: { answers: { layout: 'A', density: 'compact' } } });
        });
      });`,
    ),
  );
  await ui.goto(await t.bootstrapUrl());
  await expect(frameOf(ui).locator('#state')).toHaveText(
    Array.from({ length: 7 }, () => 'E_METHOD_NOT_ALLOWED').join(','),
  );
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('未回答');
});

test('FB-009: portは表示したiframeへ1回だけ渡す。別のwindowからの要求と、読み直した後の要求には渡さない', async ({
  page: ui,
}) => {
  await askInteractive(
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
  // HTMLへSDKを入れた表示の権限（質問を取得した後に発行する）。
  const granted = ui.waitForResponse(
    async (response) =>
      response.url().endsWith('/render-grants') &&
      ((await response.json()) as { data?: { bridge?: unknown } }).data?.bridge != null,
  );
  await ui.goto(await t.bootstrapUrl());
  const grant = (await (await granted).json()) as { data: { bridge: { instanceId: string } } };
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0 ports 1');

  // 管理UIのwindowそのものから、同じ識別子で通信の開始を求めても、portは渡さない。
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

  // 文書が自分を読み直すと、通信を終える。読み直した文書には、portを渡さない。
  await frame.locator('body').click();
  await expect(ui.getByTestId('bridge-status')).toContainText('読み直されたため');
  await expect(frame.locator('#state')).toHaveText('error E_BRIDGE_UNAVAILABLE', {
    timeout: 15_000,
  });
  // 表示し直すと、新しい表示として通信を始める。
  await ui.getByRole('button', { name: '表示し直す' }).click();
  await expect(frame.locator('#state')).toHaveText('ready 0 ports 1');
});

for (const [name, attack] of [
  ['形の違うframe', `port.postMessage('not a frame');`],
  [
    '128KiBを超えるframe',
    `port.postMessage({ protocolVersion: 1, instanceId, sequence: 1000, method: 'updateDraft', payload: { answers: { layout: 'x'.repeat(130 * 1024) }, baseDraftVersion: 0 } });`,
  ],
  [
    '1秒に20件を超えるframe',
    `for (let index = 0; index < 25; index += 1) port.postMessage({ protocolVersion: 1, instanceId, sequence: 1000 + index, method: 'ready', payload: {} });`,
  ],
] as const) {
  test(`FB-010: ${name}では通信を終え、管理UIとdaemonは動き続ける`, async ({ page: ui }) => {
    const request = await askInteractive(
      page(
        '',
        `${GRAB_PORT}
        const state = document.getElementById('state');
        onPort((port, instanceId) => {
          ${attack}
          setTimeout(() => {
            vde.ready().then(() => { state.textContent = 'still open'; }, (error) => { state.textContent = 'closed ' + error.code; });
          }, 300);
        });`,
      ),
    );
    await ui.goto(await t.bootstrapUrl());
    await expect(ui.getByTestId('bridge-status')).toContainText('決まりに合わない通信');
    await expect(frameOf(ui).locator('#state')).toHaveText('closed E_BRIDGE_CLOSED');
    // 管理UIからは、そのまま回答できる。daemonも応答する。
    const panel = panelOf(ui);
    await panel.getByRole('radio', { name: 'B', exact: true }).click();
    await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
    expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');
  });
}

test('FB-011: 別の画面の更新を知った後でも、HTMLが古い版をもとに送った回答案は競合になり、上書きしない', async ({
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
        // 知らされた新しい版ではなく、最初に受け取った版をもとにする。SDKは版を読み替えない。
        vde.feedback.updateDraft({ layout: 'A', density: 'comfortable' }, { baseDraftVersion: base }).then(
          (result) => { state.textContent = 'saved ' + result.draftVersion; },
          (error) => { state.textContent = 'error ' + error.code; },
        );
      });`,
    ),
  );
  await first.goto(await t.bootstrapUrl());
  const frame = frameOf(first);
  await expect(frame.locator('#state')).toHaveText('ready 0');

  // 別の画面（別のsession）が、回答案を保存する。
  const second = await context.newPage();
  await second.goto(await t.bootstrapUrl());
  const otherPanel = panelOf(second);
  // 2つ目の画面も、通知の接続を待たされずに表示する（同じURLへの接続をbrowserのcacheで待たせない）。
  await expect(otherPanel).toBeVisible({ timeout: 5000 });
  await otherPanel.getByRole('radio', { name: 'B', exact: true }).click();
  await otherPanel.getByRole('radio', { name: 'compact', exact: true }).click();
  await expect(otherPanel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  await expect(frame.locator('#changes')).toHaveText(/^changed \d+ B$/);

  await frame.locator('#stale').click();
  await expect(frame.locator('#state')).toHaveText('error E_DRAFT_CONFLICT');
  await expect(panelOf(first).getByRole('definition')).toHaveText(['B', 'compact']);
});

test('FB-015 / FB-016: 質問の間にHTMLとCSSが更新されても質問の版を表示し、旧版の確認はSDKからできず、本体で確認して送る', async ({
  page: ui,
}) => {
  t.write('style.css', 'p { color: rgb(0, 0, 255); }');
  const request = await askInteractive(
    `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p id="state">版1</p><script>
      document.getElementById('state').textContent = '版1 ' + Object.keys(vde.feedback).sort().join(',') + ' ' + typeof vde.confirmOlderRevision;
    </script></body></html>`,
  );
  await ui.goto(await t.bootstrapUrl());
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('版1 onDraftChanged,updateDraft undefined');

  t.atomicWrite('style.css', 'p { color: rgb(255, 0, 0); }');
  const panel = panelOf(ui);
  await expect(panel.getByRole('alert')).toContainText('新しい版があります');
  t.atomicWrite('review.html', '<!doctype html><html><body><p id="state">版3</p></body></html>');
  await expect
    .poll(async () => (await t.json<{ revision: string }>(['read', request.documentId])).revision)
    .not.toBe(request.revision);
  // 入力中の表示は、新しい版へ差し替えない。
  await expect(frame.locator('#state')).toHaveText(/^版1 /);
  await expect(frame.locator('#state')).toHaveCSS('color', 'rgb(0, 0, 255)');

  await panel.getByRole('radio', { name: 'A', exact: true }).click();
  await panel.getByRole('radio', { name: 'compact', exact: true }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  const send = panel.getByRole('button', { name: 'Agentへ回答を送信' });
  await expect(send).toBeDisabled();
  await panel
    .getByRole('checkbox', { name: '旧版への回答として送信することを確認しました' })
    .click();
  await send.click();
  await expect(panel.getByTestId('feedback-status')).toHaveText(
    '送信しました。Agentの取得を待っています',
  );
  const answered = await t.json<Request>(['feedback', 'get', request.requestId]);
  expect(answered.submission).toMatchObject({
    revision: request.revision,
    confirmedAgainstOlderRevision: true,
  });
});

test('FB-022: daemonを起動し直すと、scriptの実行は許可し直すまで止まり、許可すると回答待ちの質問へHTMLから回答案を送れる', async ({
  page: ui,
}) => {
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
  await ui.goto(await t.bootstrapUrl());
  const before = frameOf(ui);
  await expect(before.locator('#state')).toHaveText(`ready ${request.requestId}`);

  expect((await t.run(['daemon', 'restart', '--json'])).exitCode).toBe(0);
  // 再起動の前の画面のportからは、回答案を変えられない（前のdaemonのtokenと表示は使えない）。
  await before.locator('#apply').click();
  await expect(before.locator('#state')).toHaveText(/^error /);

  await ui.goto(await t.bootstrapUrl());
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('未回答');
  await expect(ui.getByTestId('html-mode')).toHaveText('静的表示');
  await expect(ui.getByTestId('document-frame')).toHaveAttribute('sandbox', '');
  // 静的表示ではscriptが動かない。
  await expect(frameOf(ui).locator('#state')).toHaveText('waiting');
  expect((await t.json<Request>(['feedback', 'get', request.requestId])).status).toBe('pending');

  await ui.getByRole('button', { name: 'scriptを動かす表示を有効にする' }).click();
  await ui.getByRole('button', { name: 'scriptを動かす', exact: true }).click();
  await expect(ui.getByTestId('html-mode')).toHaveText('scriptを動かす表示');
  await expect(frameOf(ui).locator('#state')).toHaveText(`ready ${request.requestId}`);
});

test('SEC-004: scriptを動かす表示でも、管理画面のDOM・sessionStorage・cookie・管理APIには触れられない', async ({
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
  await ui.goto(await t.bootstrapUrl());
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

test('SEC-007 / SEC-013: 登録したJSONとmoduleは相対参照で読め、未登録のfileは404で不足として示し、管理APIと外部へは通信できない', async ({
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
  await ui.goto(await t.bootstrapUrl());
  await ui.getByRole('navigation', { name: '開いている文書' }).getByText('app.html').click();
  const frame = frameOf(ui);
  await expect(frame.locator('#data')).toHaveText('登録したJSON');
  await expect(frame.locator('#module')).toHaveText('登録したmodule');
  // 未登録のfileは、同じdirectoryにあっても公開しない。
  await expect(frame.locator('#missing')).toHaveText('failed');
  await expect(frame.locator('#missing-module')).toHaveText('failed');
  await expect(frame.locator('#network')).toHaveText('blocked,blocked connect-src');
  const src = await ui.getByTestId('document-frame').getAttribute('src');
  expect((await fetch(new URL('unregistered.json', src ?? '')).catch(() => null))?.status).toBe(
    404,
  );

  // 読み込めなかったfileと、登録の方法を、本体で示す。
  const diagnostics = ui.getByTestId('render-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics).toContainText('unregistered.json を読み込もうとしましたが');
  await expect(diagnostics).toContainText('missing.js を読み込もうとしましたが');
  await expect(diagnostics).toContainText('--asset');
});

test('SEC-008: scriptを動かす表示でも、popup・上位の画面の移動・formの送信・download・workerは許可しない', async ({
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
  const before = await t.bootstrapUrl();
  await ui.goto(before);
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toContainText('"dataWorker":"blocked"');
  const results = JSON.parse((await frame.locator('#state').textContent()) ?? '{}') as Record<
    string,
    string
  >;
  expect(results).toMatchObject({ popup: 'blocked', dataWorker: 'blocked', blobWorker: 'blocked' });
  // 上位の画面は移動していない。formの送信とdownloadも起きていない（文書はそのまま）。
  expect(new URL(ui.url()).origin).toBe(new URL(before).origin);
  expect(ui.context().pages()).toHaveLength(1);
  await ui.waitForTimeout(500);
  expect(downloads).toEqual([]);
  await expect(frame.locator('#form')).toBeAttached();
});

test('FB-003: 質問定義と回答案がともに最大の大きさでも、SDKのreadyとupdateDraftが成立する', async ({
  page: ui,
}) => {
  // 64KiBに近い質問定義（日本語の説明と、長い文字列のfield）。
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
  await ui.goto(await t.bootstrapUrl());
  await expect(frameOf(ui).locator('#state')).toHaveText('ok 4000 4000,4000,4000,4000,4000', {
    timeout: 15_000,
  });
});

// HTMLへSDKを入れた表示の権限（質問の表示）の応答を待つ。
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

test('FB-009: 表示の権限が失効したら、HTMLからの回答案は受け付けず、通信を終える', async ({
  page: ui,
}) => {
  await askInteractive(page('<button id="apply" type="button">反映</button>', APPLY));
  const granted = bridgedGrant(ui);
  await ui.goto(await t.bootstrapUrl());
  const { data } = (await (await granted).json()) as { data: { grant: string } };
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0');

  // 管理APIで、表示中の権限を返却する（表示の数の上限による失効と同じ状態）。
  await ui.evaluate(async (grant) => {
    await fetch('/_/api/v1/render-grants/release', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${window.sessionStorage.getItem('vde-open.session') ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grants: [grant] }),
    });
  }, data.grant);
  await frame.locator('#apply').click();
  await expect(frame.locator('#state')).toHaveText(
    /^error E_(RENDER_GRANT_INVALID|BRIDGE_CLOSED)$/,
  );
  await expect(ui.getByTestId('bridge-status')).toContainText('表示の権限が失効したため');
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('未回答');
});

test('FB-009: 原文からプレビューへ戻ると、前の通信を終え、新しい表示として通信を始める', async ({
  page: ui,
}) => {
  await askInteractive(page('<button id="apply" type="button">反映</button>', APPLY));
  await ui.goto(await t.bootstrapUrl());
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0');
  const before = await ui.getByTestId('document-frame').getAttribute('src');

  await ui.getByRole('button', { name: '原文' }).click();
  await expect(ui.getByTestId('document-frame')).toHaveCount(0);
  await expect(ui.getByTestId('bridge-status')).toHaveCount(0);
  await ui.getByRole('button', { name: 'プレビュー' }).click();
  await expect(frame.locator('#state')).toHaveText('ready 0');
  expect(await ui.getByTestId('document-frame').getAttribute('src')).not.toBe(before);
  await expect(ui.getByTestId('bridge-status')).toContainText('回答案を受け付けています');
  await frame.locator('#apply').click();
  await expect(frame.locator('#state')).toHaveText('saved 1');
  await expect(panelOf(ui).getByTestId('feedback-status')).toHaveText('回答案を保存しました');
});

test('FB-015: staticで作った質問は、後から文書のscriptを許可しても、回答が終わるまで静的表示のまま', async ({
  page: ui,
}) => {
  t.write('q.json', JSON.stringify(questionnaire));
  t.write('review.html', page('', "document.getElementById('state').textContent = 'ran';"));
  const { request } = await t.json<{ request: Request }>([
    'ask',
    'q.json',
    '--view',
    'review.html',
  ]);
  await t.json(['open', 'review.html', '--html-mode', 'interactive']);
  await ui.goto(await t.bootstrapUrl());
  await expect(ui.getByTestId('html-mode')).toHaveText('静的表示');
  await expect(ui.getByTestId('document-frame')).toHaveAttribute('sandbox', '');
  await expect(ui.getByText('この質問は静的表示で作られたため')).toBeVisible();
  await expect(frameOf(ui).locator('#state')).toHaveText('waiting');

  // 質問が終われば、文書の表示方法（許可済みのinteractive）で表示する。
  await t.json(['feedback', 'cancel', request.requestId]);
  await expect(ui.getByTestId('html-mode')).toHaveText('scriptを動かす表示');
  await expect(frameOf(ui).locator('#state')).toHaveText('ran');
});

test('FB-009: 表示の権限が失効した後は、HTMLが何も要求しなくても、別の画面の回答案を知らせずに通信を終える', async ({
  page: ui,
}) => {
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
  await ui.goto(await t.bootstrapUrl());
  const { data } = (await (await granted).json()) as { data: { grant: string } };
  const frame = frameOf(ui);
  await expect(frame.locator('#state')).toHaveText('ready 0');

  await ui.evaluate(async (grant) => {
    await fetch('/_/api/v1/render-grants/release', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${window.sessionStorage.getItem('vde-open.session') ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grants: [grant] }),
    });
  }, data.grant);
  // 管理UIの回答panelだけが、回答案を更新する。
  const panel = panelOf(ui);
  await panel.getByRole('radio', { name: 'A', exact: true }).click();
  await expect(panel.getByTestId('feedback-status')).toHaveText('回答案を保存しました');
  await expect(ui.getByTestId('bridge-status')).toContainText('表示の権限が失効したため');
  await ui.waitForTimeout(500);
  await expect(frame.locator('#changes')).toHaveText('');
});
