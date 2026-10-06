import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, repoRoot, type TestHome } from './harness.ts';
import { connectUi, rawRequest, type UiClient } from './ui-client.ts';

const fixture = join(repoRoot, 'apps', 'cli', 'src', 'export', 'fake-browser.fixture.ts');

let t: TestHome;

beforeEach(() => {
  t = createTestHome();
});

afterEach(async () => {
  await t.cleanup();
});

// A browser executable that speaks just enough of the DevTools protocol to print a fixed PDF
// (modes in apps/cli/src/export/fake-browser.fixture.ts). What it saw is written to the record file.
function fakeBrowser(mode = 'ok', record = ''): string {
  const path = t.write(
    `browser-${mode}.sh`,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" ${mode} "${record}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function recorded(record: string): Array<Record<string, unknown>> {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function open(
  path: string,
  browser: string,
): Promise<{ documentId: string; revision: string }> {
  const opened = (
    await t.run(['open', path, '--json'], { env: { VDE_OPEN_BROWSER: browser } })
  ).json<{ documents: Array<{ documentId: string; revision: string }> }>();
  return opened.data.documents[0] as { documentId: string; revision: string };
}

function exportPdf(
  ui: UiClient,
  documentId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return rawRequest(ui.origin, `/_/api/v1/documents/${documentId}/pdf`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ui.token}`,
      Origin: ui.origin,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('PDF export through the management API', () => {
  it('returns the PDF of the requested revision, and refuses what it cannot print', async () => {
    t.write('docs/design.md', '# 設計\n\n本文\n');
    t.write('page.html', '<h1>見出し</h1>');
    const { documentId, revision } = await open('docs/design.md', fakeBrowser());
    const html = await open('page.html', fakeBrowser());
    const ui = await connectUi(t);

    const response = await exportPdf(ui, documentId, { revision });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('attachment');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.subarray(0, 5).toString()).toBe('%PDF-');

    const refused = async (result: Promise<{ text: string }>) =>
      (JSON.parse((await result).text) as { error: { code: string } }).error.code;
    expect(await refused(exportPdf(ui, html.documentId, { revision: html.revision }))).toBe(
      'E_UNSUPPORTED_FORMAT',
    );
    expect(await refused(exportPdf(ui, documentId, {}))).toBe('E_INVALID_ARGUMENT');
    expect(await refused(exportPdf(ui, documentId, { revision: `rev_${'0'.repeat(64)}` }))).toBe(
      'E_REVISION_UNAVAILABLE',
    );
    // The same checks as every other change: a session and the UI's own Origin.
    expect(await refused(exportPdf(ui, documentId, { revision }, { Authorization: '' }))).toBe(
      'E_UNAUTHORIZED',
    );
    expect(
      await refused(exportPdf(ui, documentId, { revision }, { Origin: 'http://127.0.0.1:1' })),
    ).toBe('E_UNAUTHORIZED');
  });

  it('stops the browser when the client goes away before the PDF is ready', async () => {
    t.write('design.md', '# 設計\n');
    const record = join(t.work, 'record.jsonl');
    const { documentId, revision } = await open('design.md', fakeBrowser('hang', record));
    const ui = await connectUi(t);
    const url = new URL(ui.origin);
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: `/_/api/v1/documents/${documentId}/pdf`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ui.token}`,
        Origin: ui.origin,
        'Content-Type': 'application/json',
      },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ revision }));
    // The browser has opened the page and is printing (it never finishes in this mode).
    await expect.poll(() => recorded(record).length, { timeout: 10_000 }).toBe(2);
    const pid = recorded(record)[0]?.['pid'] as number;
    expect(alive(pid)).toBe(true);
    request.destroy();
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  });

  it('reports a browser that cannot be used', async () => {
    t.write('design.md', '# 設計\n');
    const { documentId, revision } = await open('design.md', join(t.work, 'missing-browser'));
    const ui = await connectUi(t);
    const response = await exportPdf(ui, documentId, { revision });
    expect(JSON.parse(response.text)).toMatchObject({
      ok: false,
      error: { code: 'E_BROWSER_NOT_FOUND', details: { source: 'VDE_OPEN_BROWSER' } },
    });
  });
});
