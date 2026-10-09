import { readFileSync, renameSync, unlinkSync } from 'node:fs';

import {
  LIMITS,
  type DocumentSummary,
  type OpenResult,
  type SearchResult,
} from '../../packages/shared/src/index.ts';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';
import { connectUi, rawRequest } from './ui-client.ts';

let t: TestHome;
const png = readFileSync(new URL('../fixtures/images/sample.png', import.meta.url));

beforeEach(() => {
  t = createTestHome();
});
afterEach(async () => {
  await t.cleanup();
});

async function open(name: string): Promise<DocumentSummary> {
  const result = (await t.run([name, '--json'])).json<OpenResult>();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.data.documents[0]!;
}

it('opens a binary image directly and serves only its immutable bytes with the image MIME type', async () => {
  t.write('写真 sample.PNG', png);
  t.write('secret.png', png);
  const doc = await open('写真 sample.PNG');
  expect(doc).toMatchObject({
    format: 'image',
    title: '写真 sample.PNG',
    htmlMode: null,
    sourceKind: 'file',
  });
  const ui = await connectUi(t);
  const grant = await ui.grant(doc.documentId);
  const image = await rawRequest(ui.previewOrigin, new URL(grant.documentUrl!).pathname);
  expect(image.status).toBe(200);
  expect(image.body).toEqual(png);
  expect(image.headers['content-type']).toBe('image/png');
  expect(image.headers['x-content-type-options']).toBe('nosniff');
  expect(image.headers['content-security-policy']).toContain("default-src 'none'");
  expect((await rawRequest(ui.previewOrigin, `${ui.filesPath(grant)}secret.png`)).status).toBe(404);
  for (const selectors of [[], ['--outline'], ['--section', 'sec_0000']]) {
    const result = (await t.run(['read', doc.documentId, ...selectors, '--json'])).json();
    expect(result.error.code).toBe('E_UNSUPPORTED_FORMAT');
  }
  const pdf = await ui.api(`/documents/${doc.documentId}/pdf`, {
    method: 'POST',
    body: { revision: doc.revision },
  });
  expect(pdf.json.error.code).toBe('E_UNSUPPORTED_FORMAT');
  await t.run(['close', doc.documentId]);
  expect((await rawRequest(ui.previewOrigin, new URL(grant.documentUrl!).pathname)).status).toBe(
    404,
  );
});

it('includes image formats in directory and glob registration without treating CSS or data as images', async () => {
  const names = [
    'png',
    'apng',
    'jpg',
    'jpeg',
    'jpe',
    'jif',
    'jfif',
    'pjpeg',
    'pjp',
    'gif',
    'webp',
    'avif',
    'svg',
    'bmp',
    'ico',
    'cur',
    'jxl',
    'tif',
    'tiff',
    'heic',
    'heif',
  ];
  for (const extension of names) t.write(`images/picture.${extension}`, png);
  t.write('images/style.css', 'body {}');
  t.write('images/data.json', '{}');
  t.write('images/.hidden.png', png);
  const result = (await t.run(['open', 'images', '--json'])).json<OpenResult>();
  expect(result.ok).toBe(true);
  expect(result.data.documents).toHaveLength(names.length);
  expect(result.data.documents.every((doc) => doc.format === 'image')).toBe(true);
  await t.run(['close', '--all']);
  const glob = (await t.run(['open', 'images/*.png', '--json'])).json<OpenResult>();
  expect(glob.data.documents.map((doc) => doc.title)).toEqual(['picture.png']);
});

it('retains image revisions across atomic replacement, deletion, recreation, and daemon restart', async () => {
  const path = t.write(
    'drawing.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"/>',
  );
  const first = await open('drawing.svg');
  let ui = await connectUi(t);
  const old = await ui.grant(first.documentId, first.revision!);
  const next = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"/>';
  renameSync(t.write('drawing.tmp', next), path);
  const refreshed = (await t.run(['refresh', first.documentId, '--json'])).json<{
    documents: DocumentSummary[];
  }>();
  const current = refreshed.data.documents[0]!;
  expect(current.revision).not.toBe(first.revision);
  expect((await rawRequest(ui.previewOrigin, new URL(old.documentUrl!).pathname)).text).toContain(
    'width="32"',
  );
  unlinkSync(path);
  await t.run(['refresh', first.documentId]);
  expect((await rawRequest(ui.previewOrigin, new URL(old.documentUrl!).pathname)).status).toBe(200);
  t.write('drawing.svg', next);
  await t.run(['refresh', first.documentId]);
  await t.run(['daemon', 'restart']);
  ui = await connectUi(t);
  const restored = await ui.grant(first.documentId, current.revision!);
  expect((await rawRequest(ui.previewOrigin, new URL(restored.documentUrl!).pathname)).text).toBe(
    next,
  );
});

it('searches image titles and paths without parsing binary content', async () => {
  t.write('diagram.png', png);
  const doc = await open('diagram.png');
  const query = async () =>
    (await t.run(['search', 'diagram', '--mode', 'path', '--json'])).json<SearchResult>().data;
  await expect.poll(async () => (await query()).hits.length).toBe(1);
  expect((await query()).hits[0]).toMatchObject({
    documentId: doc.documentId,
    extraction: 'image',
  });
});

it('automatically refreshes a saved image while preserving its earlier revision', async () => {
  t.write('watched.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="32"/>');
  const doc = await open('watched.svg');
  const ui = await connectUi(t);
  const previous = await ui.grant(doc.documentId, doc.revision!);
  t.write('watched.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64"/>');
  await expect
    .poll(
      async () =>
        (await t.run(['list', '--json'])).json<{ documents: DocumentSummary[] }>().data.documents[0]
          ?.revision,
      { timeout: 12_000 },
    )
    .not.toBe(doc.revision);
  expect(
    (await rawRequest(ui.previewOrigin, new URL(previous.documentUrl!).pathname)).text,
  ).toContain('width="32"');
  const current = await ui.grant(doc.documentId);
  expect(
    (await rawRequest(ui.previewOrigin, new URL(current.documentUrl!).pathname)).text,
  ).toContain('width="64"');
});

it('applies the source byte limit to images and does not publish an oversized image', async () => {
  t.write('huge.png', Buffer.alloc(LIMITS.documentBytes + 1));
  const result = (await t.run(['open', 'huge.png', '--json'])).json();
  expect(result.error.code).toBe('E_LIMIT_EXCEEDED');
  const list = (await t.run(['list', '--json'])).json<{ documents: DocumentSummary[] }>();
  expect(list.data.documents).toHaveLength(0);
});
