import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { createE2eHome, type E2eHome } from './harness.ts';

const dist = fileURLToPath(new URL('../../apps/cli/dist', import.meta.url));
const DEV_ORIGIN = 'http://127.0.0.1:5173';

let t: E2eHome;

test.beforeEach(() => {
  // Confirm that development settings have no effect on the distribution even when passed.
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

test('SEC-020: the development origin allowance and HMR are not left in the distribution', async ({
  request,
}) => {
  t.write('site/index.html', '<p>本文</p>');
  const opened = await t.json<{ documents: Array<{ documentId: string }> }>([
    'open',
    'site/index.html',
  ]);
  const ui = (await t.uiUrl()).replace(/\/$/, '');
  // Requests claiming the development origin are rejected in distribution builds.
  const devRead = await request.get(`${ui}/_/api/v1/documents`, {
    headers: { Origin: DEV_ORIGIN },
  });
  expect(devRead.status()).toBe(401);
  const crossSite = await request.get(`${ui}/_/api/v1/documents`, {
    headers: { Origin: ui, 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(crossSite.status()).toBe(401);

  // The policies of the management UI and the document view have no development exceptions.
  const index = await request.get(`${ui}/`);
  const uiCsp = index.headers()['content-security-policy'] ?? '';
  for (const forbidden of ['unsafe-eval', 'ws:', 'wss:', DEV_ORIGIN, '5173', '*']) {
    expect(uiCsp, forbidden).not.toContain(forbidden);
  }
  expect(index.headers()['access-control-allow-origin']).toBeUndefined();
  const granted = await request.post(
    `${ui}/_/api/v1/documents/${opened.documents[0]?.documentId ?? ''}/render-grants`,
    { headers: { Origin: ui, 'Content-Type': 'application/json' }, data: {} },
  );
  const { documentUrl } = ((await granted.json()) as { data: { documentUrl: string } }).data;
  const documentCsp = (await request.get(documentUrl)).headers()['content-security-policy'] ?? '';
  // Only the management UI origin may embed the document. The development origin is not included.
  expect(documentCsp).toContain(`frame-ancestors ${ui};`);
  expect(documentCsp).not.toContain(DEV_ORIGIN);

  // The bundled UI contains no Vite development client, HMR, or development origin.
  const webFiles = filesUnder(join(dist, 'web'));
  expect(webFiles.length).toBeGreaterThan(0);
  for (const file of webFiles.filter((path) => /\.(html|js|css)$/.test(path))) {
    const content = readFileSync(file, 'utf8');
    for (const forbidden of ['/@vite/client', '@react-refresh', 'import.meta.hot', DEV_ORIGIN]) {
      expect(content.includes(forbidden), `${file}: ${forbidden}`).toBe(false);
    }
  }
  expect((await request.get(`${ui}/@vite/client`)).status()).toBe(404);
  // The daemon distribution reads development variables only when run from source.
  const daemon = readFileSync(join(dist, 'daemon.js'), 'utf8');
  expect(daemon).not.toContain('allowedHosts');
});
