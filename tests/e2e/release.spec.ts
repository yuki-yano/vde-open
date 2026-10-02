import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

const dist = fileURLToPath(new URL('../../apps/cli/dist', import.meta.url));
const DEV_ORIGIN = 'http://127.0.0.1:5173';

let t: E2eHome;

test.beforeEach(() => {
  // 開発用の設定を渡しても、配布物では効かないことを確かめる。
  t = createE2eHome({
    VDE_OPEN_DEV_UI_ORIGIN: DEV_ORIGIN,
    VDE_OPEN_DEV_BACKEND: 'http://127.0.0.1:43117',
  });
});

test.afterEach(async () => {
  await t.cleanup();
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

test('SEC-020: 開発用のoriginの許可とHMRは、配布物に残っていない', async ({ request }) => {
  t.write('site/index.html', '<p>本文</p>');
  const opened = await t.json<{ documents: Array<{ documentId: string }> }>([
    'open',
    'site/index.html',
  ]);
  const ui = (await t.uiUrl()).replace(/\/$/, '');
  const ticket = (await t.bootstrapUrl()).split('#bootstrap=')[1] as string;

  // 開発用のoriginからは、ticketを交換できない。
  const fromDev = await request.post(`${ui}/_/api/v1/sessions/bootstrap`, {
    headers: { Origin: DEV_ORIGIN, 'Content-Type': 'application/json' },
    data: { ticket },
  });
  expect(fromDev.status()).toBe(401);
  expect(fromDev.headers()['access-control-allow-origin']).toBeUndefined();

  const exchanged = await request.post(`${ui}/_/api/v1/sessions/bootstrap`, {
    headers: { Origin: ui, 'Content-Type': 'application/json' },
    data: { ticket: (await t.bootstrapUrl()).split('#bootstrap=')[1] as string },
  });
  const { token } = ((await exchanged.json()) as { data: { token: string } }).data;

  // 有効なsessionでも、開発用のoriginを名乗るrequestは受け付けない。
  const authorized = { Authorization: `Bearer ${token}` };
  const devRead = await request.get(`${ui}/_/api/v1/documents`, {
    headers: { ...authorized, Origin: DEV_ORIGIN },
  });
  expect(devRead.status()).toBe(401);
  const crossSite = await request.get(`${ui}/_/api/v1/documents`, {
    headers: { ...authorized, Origin: ui, 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(crossSite.status()).toBe(401);

  // 管理UIと文書の表示のpolicyに、開発用の例外がない。
  const index = await request.get(`${ui}/`);
  const uiCsp = index.headers()['content-security-policy'] ?? '';
  for (const forbidden of ['unsafe-eval', 'ws:', 'wss:', DEV_ORIGIN, '5173', '*']) {
    expect(uiCsp, forbidden).not.toContain(forbidden);
  }
  expect(index.headers()['access-control-allow-origin']).toBeUndefined();
  const granted = await request.post(
    `${ui}/_/api/v1/documents/${opened.documents[0]?.documentId ?? ''}/render-grants`,
    { headers: { ...authorized, Origin: ui, 'Content-Type': 'application/json' }, data: {} },
  );
  const { documentUrl } = ((await granted.json()) as { data: { documentUrl: string } }).data;
  const documentCsp = (await request.get(documentUrl)).headers()['content-security-policy'] ?? '';
  // 文書を埋め込めるのは、管理UIのoriginだけ。開発用のoriginは含まない。
  expect(documentCsp).toContain(`frame-ancestors ${ui};`);
  expect(documentCsp).not.toContain(DEV_ORIGIN);

  // 同梱のUIに、Viteの開発用client・HMR・開発用originの指定が含まれていない。
  const webFiles = filesUnder(join(dist, 'web'));
  expect(webFiles.length).toBeGreaterThan(0);
  for (const file of webFiles.filter((path) => /\.(html|js|css)$/.test(path))) {
    const content = readFileSync(file, 'utf8');
    for (const forbidden of ['/@vite/client', '@react-refresh', 'import.meta.hot', DEV_ORIGIN]) {
      expect(content.includes(forbidden), `${file}: ${forbidden}`).toBe(false);
    }
  }
  expect((await request.get(`${ui}/@vite/client`)).status()).toBe(404);
  // daemonの配布物は、開発用の変数を「sourceから実行したとき」にだけ読む。
  const daemon = readFileSync(join(dist, 'daemon.js'), 'utf8');
  expect(daemon).not.toContain('allowedHosts');
});
