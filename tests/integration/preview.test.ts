import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';
import { connectUi, rawRequest, type GrantData, type UiClient } from './ui-client.ts';

interface Summary {
  documentId: string;
  title: string;
  revision: string;
  sourceState: string;
}

interface StoredRevision {
  revision: string;
  documentLogicalPath: string;
  assets: Array<{ logicalPath: string; role: string; mime: string; sha256: string }>;
}

let t: TestHome;
let outside: string;
let beacon: Server | null;
let beaconHits: string[];

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SECRET = 'TOP-SECRET-CONTENT-do-not-serve';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  t = createTestHome();
  // Next to the working directory. Secret files outside the assets-root.
  outside = join(t.work, '..', 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.png'), SECRET);
  writeFileSync(join(outside, 'secret.css'), `.x{content:"${SECRET}"}`);
  beacon = null;
  beaconHits = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (beacon) beacon.close(() => resolve());
    else resolve();
  });
  await t.cleanup();
});

// A server that only records incoming requests. Confirms the backend and browser make no external requests.
async function startBeacon(): Promise<string> {
  const server = createServer((request, response) => {
    beaconHits.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'text/css' });
    response.end('.beacon{}');
  });
  beacon = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function open(args: string[]): Promise<Summary> {
  const result = await t.run(['open', ...args, '--json']);
  const envelope = result.json<{ documents: Summary[] }>();
  if (!envelope.ok) throw new Error(`open failed: ${JSON.stringify(envelope.error)}`);
  return envelope.data.documents[0] as Summary;
}

function currentRevision(documentId: string): StoredRevision {
  const state = JSON.parse(readFileSync(join(t.home, 'state.json'), 'utf8')) as {
    payload: {
      documents: Record<string, { currentRevision: string; revisions: StoredRevision[] }>;
    };
  };
  const record = state.payload.documents[documentId];
  return record?.revisions.find(
    (entry) => entry.revision === record.currentRevision,
  ) as StoredRevision;
}

const assetPaths = (documentId: string) =>
  currentRevision(documentId).assets.map((asset) => asset.logicalPath);
const blobExists = (content: Buffer | string) => existsSync(join(t.home, 'blobs', sha256(content)));

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const list = async () =>
  (await t.run(['list', '--json'])).json<{ documents: Summary[] }>().data.documents;

function site(html: string): void {
  t.write('site/index.html', html);
  t.write('site/img/a.png', PNG);
  t.write('site/css/site.css', '.a{background:url(../img/a.png)}');
}

async function previewGet(ui: UiClient, grant: GrantData, path: string, method = 'GET') {
  return rawRequest(ui.previewOrigin, `${ui.filesPath(grant)}${path}`, { method });
}

describe('DOC-011 referenced files and the document revision', () => {
  it('re-saving the same content keeps the revision, and a CSS-only change makes a new revision', async () => {
    site('<link rel="stylesheet" href="css/site.css"><img src="img/a.png"><p>本文</p>');
    const first = await open(['site/index.html']);
    expect(assetPaths(first.documentId)).toEqual(['css/site.css', 'img/a.png']);

    // Re-save both the body and the asset with the same content.
    writeFileSync(join(t.work, 'site/index.html'), readFileSync(join(t.work, 'site/index.html')));
    writeFileSync(join(t.work, 'site/css/site.css'), '.a{background:url(../img/a.png)}');
    await t.run(['refresh', '--json']);
    expect((await list())[0]?.revision).toBe(first.revision);

    // Change only the CSS. Even with the same body, it becomes a different revision. The watch follows.
    writeFileSync(join(t.work, 'site/css/site.css'), '.a{color:red}');
    const changed = await waitFor(list, (documents) => documents[0]?.revision !== first.revision);
    expect(changed[0]?.documentId).toBe(first.documentId);
    // The image the CSS no longer references remains, since the HTML references it.
    expect(assetPaths(first.documentId)).toEqual(['css/site.css', 'img/a.png']);

    // When a referenced file that did not exist is created, it is picked up.
    t.write('site/index.html', '<img src="img/a.png"><img src="img/later.png">');
    await waitFor(list, (documents) => documents[0]?.revision !== changed[0]?.revision);
    expect(assetPaths(first.documentId)).toEqual(['img/a.png']);
    t.write('site/img/later.png', PNG);
    await waitFor(
      () => Promise.resolve(assetPaths(first.documentId)),
      (paths) => paths.includes('img/later.png'),
    );
  });

  it('renders with the assets of a previous revision when that revision is given', async () => {
    site('<link rel="stylesheet" href="css/site.css"><p>本文</p>');
    const first = await open(['site/index.html']);
    writeFileSync(join(t.work, 'site/css/site.css'), '.a{color:red}');
    await t.run(['refresh', '--json']);
    const ui = await connectUi(t);
    const old = await ui.grant(first.documentId, first.revision);
    const current = await ui.grant(first.documentId);
    expect(current.revision).not.toBe(first.revision);
    expect((await previewGet(ui, old, 'css/site.css')).text).toContain('url(../img/a.png)');
    expect((await previewGet(ui, current, 'css/site.css')).text).toBe('.a{color:red}');
  });
});

describe('SEC-009 references pointing outside the assets-root', () => {
  it('does not read files outside the root at registration', async () => {
    site(`<img src="img/a.png"><img src="../../outside/secret.png"><img src="..%2f..%2foutside%2fsecret.png">
      <img src="%252e%252e/%252e%252e/outside/secret.png"><img src="file://${join(outside, 'secret.png')}">
      <img src="${join(outside, 'secret.png')}"><img src="\\\\server\\share\\secret.png">
      <img src="img/..%5c..%5c..%5coutside/secret.png"><img src="img/%00.png">
      <link rel="stylesheet" href="../../outside/secret.css">`);
    const document = await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['img/a.png']);
    expect(blobExists(PNG)).toBe(true);
    expect(blobExists(SECRET)).toBe(false);
    expect(blobExists(`.x{content:"${SECRET}"}`)).toBe(false);
  });

  it('even with --asset, paths outside the root or ambiguous ones cannot be registered', async () => {
    site('<p>本文</p>');
    for (const asset of [
      '../../outside/secret.png',
      '..%2f..%2foutside%2fsecret.png',
      `file://${join(outside, 'secret.png')}`,
      '\\\\server\\share\\a.png',
      'https://example.com/a.png',
      'img/',
      'missing.png',
      'site.txt',
    ]) {
      const result = await t.run(['open', 'site/index.html', '--asset', asset, '--json']);
      expect(result.exitCode, asset).toBe(5);
      expect(result.json().error.code, asset).toBe('E_ASSET_REJECTED');
    }
    // A failed open has not registered the document.
    expect(await list()).toEqual([]);
    expect(blobExists(SECRET)).toBe(false);
  });

  it('at serving time too, paths outside the root or unregistered ones are unreachable', async () => {
    site('<img src="img/a.png">');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    expect((await previewGet(ui, grant, 'img/a.png')).status).toBe(200);

    for (const path of [
      '../../../outside/secret.png',
      'img/../../../../outside/secret.png',
      '..%2f..%2foutside%2fsecret.png',
      '%2e%2e/%2e%2e/%2e%2e/outside/secret.png',
      '%252e%252e%252f%252e%252e%252foutside%252fsecret.png',
      'img%2fa.png',
      'img%5ca.png',
      'img/a.png%00',
      'img/a.png%00.css',
      '%00',
      `/${join(outside, 'secret.png')}`,
      `file://${join(outside, 'secret.png')}`,
      '..\\..\\outside\\secret.png',
      '%E3%81',
    ]) {
      const response = await previewGet(ui, grant, path);
      expect(response.status, path).toBe(404);
      expect(response.text, path).toBe('Not Found');
    }
  });
});

describe('SEC-010 unregistered files inside the assets-root', () => {
  it('does not reveal existence, and returns no directory listing', async () => {
    site('<img src="img/a.png"><img src=".env"><img src=".git/logo.png">');
    t.write('site/secret.txt', SECRET);
    t.write('site/.env', `KEY=${SECRET}`);
    t.write('site/.git/logo.png', PNG);
    t.write('site/img/private.png', Buffer.concat([PNG, Buffer.from('private')]));
    t.write('site/data.json', `{"secret":"${SECRET}"}`);
    t.write('site/app.js', `const secret = "${SECRET}";`);
    const document = await open(['site/index.html']);
    // Files whose names start with `.` are not registered even if the document references them.
    expect(assetPaths(document.documentId)).toEqual(['img/a.png']);

    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const unknownGrant = await rawRequest(ui.previewOrigin, `/r/${'A'.repeat(43)}/files/img/a.png`);
    expect(unknownGrant.status).toBe(404);

    for (const path of [
      'secret.txt',
      '.env',
      '.git/logo.png',
      'img/private.png',
      'data.json',
      'app.js',
      'no-such-file.png',
      'img',
      'img/',
      '',
      '.',
      'index.html/',
      'index.html/x',
    ]) {
      const response = await previewGet(ui, grant, path);
      // Existing files, missing files, and URLs without a grant all get the same response.
      expect(response.status, path).toBe(404);
      expect(response.text, path).toBe(unknownGrant.text);
      expect(response.headers['content-type'], path).toBe(unknownGrant.headers['content-type']);
    }
  });

  it('only the individually given file is added; other files in the same directory are not exposed', async () => {
    site('<p>本文</p>');
    t.write('site/data.json', '{"ok":true}');
    t.write('site/other.json', `{"secret":"${SECRET}"}`);
    const document = await open(['site/index.html', '--asset', 'data.json']);
    expect(assetPaths(document.documentId)).toEqual(['data.json']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const data = await previewGet(ui, grant, 'data.json');
    expect(data.status).toBe(200);
    expect(data.headers['content-type']).toBe('application/json; charset=utf-8');
    expect((await previewGet(ui, grant, 'other.json')).status).toBe(404);

    // Reopening without the option keeps the registered selection.
    await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['data.json']);
  });
});

describe('SEC-011 reaching outside the root via symlinks', () => {
  it('does not read a symlink pointing outside the root, whether a file or a directory', async () => {
    site('<img src="img/a.png"><img src="link.png"><img src="linked/secret.png">');
    symlinkSync(join(outside, 'secret.png'), join(t.work, 'site/link.png'));
    symlinkSync(outside, join(t.work, 'site/linked'));
    // A symlink pointing inside the root is readable.
    symlinkSync(join(t.work, 'site/img/a.png'), join(t.work, 'site/inner.png'));
    t.write(
      'site/index.html',
      '<img src="img/a.png"><img src="link.png"><img src="linked/secret.png"><img src="inner.png">',
    );
    const document = await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['img/a.png', 'inner.png']);
    expect(blobExists(SECRET)).toBe(false);

    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    expect((await previewGet(ui, grant, 'link.png')).status).toBe(404);
    expect((await previewGet(ui, grant, 'linked/secret.png')).status).toBe(404);
    expect((await previewGet(ui, grant, 'inner.png')).status).toBe(200);
  });

  it('even inside the root, does not read a symlink pointing to a secret file or a file of another kind', async () => {
    t.write('site/.env', `KEY=${SECRET}`);
    t.write('site/.git/secret.png', `${SECRET}-git`);
    t.write('site/private.json', `{"secret":"${SECRET}"}`);
    t.write('site/notes.txt', `${SECRET}-text`);
    t.write('site/img/a.png', PNG);
    // Symlinks named like images or CSS. Their targets are files that must not be registered.
    symlinkSync(join(t.work, 'site/.env'), join(t.work, 'site/public.png'));
    symlinkSync(join(t.work, 'site/.git/secret.png'), join(t.work, 'site/logo.png'));
    symlinkSync(join(t.work, 'site/private.json'), join(t.work, 'site/data.png'));
    symlinkSync(join(t.work, 'site/notes.txt'), join(t.work, 'site/style.css'));
    symlinkSync(join(t.work, 'site/.git'), join(t.work, 'site/assets'));
    // A symlink pointing to a file of the same kind that may be exposed is readable.
    symlinkSync(join(t.work, 'site/img/a.png'), join(t.work, 'site/alias.png'));
    t.write(
      'site/index.html',
      `<img src="public.png"><img src="logo.png"><img src="data.png"><img src="assets/secret.png">
       <link rel="stylesheet" href="style.css"><img src="alias.png">`,
    );
    const document = await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['alias.png']);
    for (const content of [
      `KEY=${SECRET}`,
      `${SECRET}-git`,
      `{"secret":"${SECRET}"}`,
      `${SECRET}-text`,
    ]) {
      expect(blobExists(content), content).toBe(false);
    }
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    for (const path of ['public.png', 'logo.png', 'data.png', 'style.css', 'assets/secret.png']) {
      const response = await previewGet(ui, grant, path);
      expect(response.status, path).toBe(404);
      expect(response.text, path).not.toContain(SECRET);
    }

    // Even given individually, a symlink pointing to a secret file cannot be registered.
    for (const asset of ['public.png', 'logo.png', 'data.png']) {
      const result = await t.run(['open', 'site/index.html', '--asset', asset, '--json']);
      expect(result.exitCode, asset).toBe(5);
    }
    // JSON can be registered only when given individually. The same for a JSON symlink pointing to JSON.
    symlinkSync(join(t.work, 'site/private.json'), join(t.work, 'site/alias.json'));
    await open(['site/index.html', '--asset', 'alias.json']);
    expect(assetPaths(document.documentId)).toEqual(['alias.json', 'alias.png']);
  });

  it('does not read outside files even when a directory is swapped to point outside the root after registration', async () => {
    site('<img src="img/a.png">');
    const document = await open(['site/index.html']);
    writeFileSync(join(outside, 'a.png'), SECRET);

    // Swap the image directory for a symlink pointing outside the root.
    renameSync(join(t.work, 'site/img'), join(t.work, 'site/img-original'));
    symlinkSync(outside, join(t.work, 'site/img'));
    await t.run(['refresh', '--json']);
    expect(assetPaths(document.documentId)).toEqual([]);
    expect(blobExists(SECRET)).toBe(false);

    // Swap the root itself. The document becomes unreadable, and the swapped-in content is not picked up.
    rmSync(join(t.work, 'site/img'));
    renameSync(join(t.work, 'site/img-original'), join(t.work, 'site/img'));
    await t.run(['refresh', '--json']);
    expect(assetPaths(document.documentId)).toEqual(['img/a.png']);
    writeFileSync(join(outside, 'index.html'), `<p>${SECRET}</p><img src="a.png">`);
    renameSync(join(t.work, 'site'), join(t.work, 'site-original'));
    symlinkSync(outside, join(t.work, 'site'));
    await t.run(['refresh', '--json']);
    const after = (await list())[0] as Summary;
    expect(after.revision).toBe(document.revision);
    expect(after.sourceState).not.toBe('ready');
    const read = await t.run(['read', document.documentId, '--json']);
    expect(read.stdout).not.toContain(SECRET);
    expect(blobExists(SECRET)).toBe(false);
  });
});

describe('SEC-012 external references and cycles in CSS', () => {
  it('the backend does not fetch external URLs, and they do not remain in the converted CSS', async () => {
    const evil = await startBeacon();
    t.write(
      'site/index.html',
      `<link rel="stylesheet" href="css/site.css"><link rel="stylesheet" href="${evil}/direct.css">
       <style>@import url(${evil}/inline.css); .x { background: url(${evil}/bg.png) }</style>
       <img src="img/a.png" srcset="img/a.png 1x, ${evil}/2x.png 2x, img/missing.png 3x">`,
    );
    t.write('site/img/a.png', PNG);
    t.write(
      'site/css/site.css',
      String.raw`@import url("${evil}/import.css"); @import "//127.0.0.1/proto.css";
       @\69mport "${evil}/escaped-import.css";
       .a { background: url(${evil}/a.png); color: red }
       .b { background: url(../img/a.png) }
       .c { --image: "${evil}/var.png"; background: image-set(var(--image) 1x); color: blue }
       .d { b\61 ckground: url(${evil}/escaped-property.png); margin: 0 }`,
    );
    const document = await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['css/site.css', 'img/a.png']);

    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const html = (await previewGet(ui, grant, 'index.html')).text;
    const css = (await previewGet(ui, grant, 'css/site.css')).text;
    expect(html).not.toContain(evil);
    expect(html).toContain('srcset="img/a.png 1x"');
    // A string in a custom property is not fetched by itself, so it remains.
    // The declaration that uses the value as a URL (image-set(var(--image))) is the one invalidated.
    expect(css).toContain('--image:"');
    expect(css.replace(/--image:"[^"]*"/, '')).not.toContain('127.0.0.1');
    expect(css).toContain('.a{color:red}');
    expect(css).toContain('.b{background:url(../img/a.png)}');
    // @import and declarations with escaped names, and image-set injecting a URL from a variable, are invalidated.
    expect(css).not.toContain('mport');
    expect(css).not.toContain('image-set');
    expect(css).not.toContain('escaped-property');
    expect(css).toContain('color:blue');
    expect(css).toContain('.d{margin:0}');
    expect(grant.diagnostics.map((entry) => entry.code)).toContain('css-invalid');
    expect(grant.diagnostics.filter((entry) => entry.code === 'remote-asset-blocked').length).toBe(
      7,
    );
    // Not one external request was made between registration and serving.
    expect(beaconHits).toEqual([]);
  });

  it('registration finishes even with CSS files importing each other', async () => {
    t.write('site/index.html', '<link rel="stylesheet" href="a.css">');
    t.write('site/a.css', '@import "b.css"; .a{color:red}');
    t.write('site/b.css', '@import "a.css"; @import "c/c.css"; .b{color:blue}');
    t.write('site/c/c.css', '@import "../a.css"; .c{background:url(../img/a.png)}');
    t.write('site/img/a.png', PNG);
    const document = await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['a.css', 'b.css', 'c/c.css', 'img/a.png']);
  });

  it('CSS import depth has a limit, and nothing beyond it is registered', async () => {
    t.write('site/index.html', '<link rel="stylesheet" href="s0.css">');
    for (let depth = 0; depth < 12; depth += 1) {
      t.write(`site/s${String(depth)}.css`, `@import "s${String(depth + 1)}.css";`);
    }
    const document = await open(['site/index.html']);
    // s0 read directly from the document, plus 8 levels from there.
    expect(assetPaths(document.documentId)).toHaveLength(9);
  });
});

describe('SEC-014 SVG', () => {
  it('registers only SVGs referenced as images, and serves them with headers that prevent scripts', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    t.write('site/img.svg', svg);
    t.write('site/embedded.svg', `${svg}<!-- object -->`);
    t.write('site/framed.svg', `${svg}<!-- iframe -->`);
    t.write('site/script.svg', `${svg}<!-- script -->`);
    t.write(
      'site/index.html',
      `<img src="img.svg"><object data="embedded.svg" type="image/svg+xml"></object>
       <iframe src="framed.svg"></iframe><embed src="embedded.svg"><script src="script.svg"></script>
       <svg><image href="img.svg"/><script>alert(2)</script></svg>`,
    );
    const document = await open(['site/index.html']);
    expect(currentRevision(document.documentId).assets).toMatchObject([
      { logicalPath: 'img.svg', role: 'svg', mime: 'image/svg+xml' },
    ]);

    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const html = (await previewGet(ui, grant, 'index.html')).text;
    expect(html).toContain('<img src="img.svg">');
    for (const removed of ['<object', '<iframe', '<embed', '<script', '<svg']) {
      expect(html, removed).not.toContain(removed);
    }
    expect(grant.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['inline-svg-removed', 'embed-removed', 'script-removed']),
    );

    // Even opened directly, the script in the SVG does not run (sandbox and a script-forbidding policy).
    const direct = await previewGet(ui, grant, 'img.svg');
    expect(direct.status).toBe(200);
    expect(direct.headers['content-type']).toBe('image/svg+xml');
    expect(direct.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(direct.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('allow-scripts');
    for (const path of ['embedded.svg', 'framed.svg', 'script.svg']) {
      expect((await previewGet(ui, grant, path)).status, path).toBe(404);
    }
  });
});

describe('SEC-015 expiry of render grants', () => {
  it('an issued URL cannot be read after the document is closed, the session is revoked, or a restart', async () => {
    site('<img src="img/a.png">');
    t.write('other/index.html', '<p>別の文書</p>');
    const document = await open(['site/index.html']);
    const other = await open(['other/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const otherGrant = await ui.grant(other.documentId);
    expect((await previewGet(ui, grant, 'index.html')).status).toBe(200);

    // A grant works only within the document it was issued for. Files of another document cannot be read.
    expect((await previewGet(ui, otherGrant, 'img/a.png')).status).toBe(404);
    // It cannot authenticate to the management API. Nor can the management token be used as a preview URL.
    const asToken = await rawRequest(ui.origin, '/_/api/v1/documents', {
      headers: { Authorization: `Bearer ${grant.grant}` },
    });
    expect(asToken.status).toBe(401);
    expect((await rawRequest(ui.previewOrigin, `/r/${ui.token}/files/index.html`)).status).toBe(
      404,
    );
    expect((await rawRequest(ui.origin, `${ui.filesPath(grant)}index.html`)).status).toBe(404);

    // A grant released by its own session becomes unusable immediately.
    const released = await ui.api<{ released: number }>('/render-grants/release', {
      method: 'POST',
      body: { grants: [otherGrant.grant] },
    });
    expect(released.json.data.released).toBe(1);
    expect((await previewGet(ui, otherGrant, 'index.html')).status).toBe(404);

    // Another session cannot release a grant of a different session.
    const second = await connectUi(t);
    const stolen = await second.api<{ released: number }>('/render-grants/release', {
      method: 'POST',
      body: { grants: [grant.grant] },
    });
    expect(stolen.json.data.released).toBe(0);
    expect((await previewGet(ui, grant, 'index.html')).status).toBe(200);

    // Closing the document expires it. Even if never used while closed, the old grant does not return after reopening.
    const unused = await ui.grant(document.documentId);
    await t.run(['close', document.documentId, '--json']);
    await open(['site/index.html']);
    expect((await previewGet(ui, unused, 'index.html')).status).toBe(404);
    expect((await previewGet(ui, grant, 'index.html')).status).toBe(404);

    // Revoking the session also expires the grants it issued.
    const fresh = await ui.grant(document.documentId);
    expect((await previewGet(ui, fresh, 'index.html')).status).toBe(200);
    await ui.api('/session', { method: 'DELETE' });
    expect((await previewGet(ui, fresh, 'index.html')).status).toBe(404);

    // After a daemon restart, the old grant is unusable.
    const third = await connectUi(t);
    const beforeRestart = await third.grant(document.documentId);
    await t.run(['daemon', 'restart', '--json']);
    const restarted = await connectUi(t);
    expect(
      (await rawRequest(restarted.previewOrigin, `${third.filesPath(beforeRestart)}index.html`))
        .status,
    ).toBe(404);
  });

  it('a grant is bound to the revision it renders', async () => {
    site('<p>版1</p>');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const first = await ui.grant(document.documentId);
    t.write('site/index.html', '<p>版2</p>');
    await t.run(['refresh', '--json']);
    const second = await ui.grant(document.documentId);
    // The old grant keeps rendering the old revision. The new revision needs a new grant.
    expect((await previewGet(ui, first, 'index.html')).text).toContain('版1');
    expect((await previewGet(ui, second, 'index.html')).text).toContain('版2');

    // No grant is issued for an unretained revision or a document that is not open.
    const unknown = await ui.api(`/documents/${document.documentId}/render-grants`, {
      method: 'POST',
      body: { revision: `rev_${'0'.repeat(64)}` },
    });
    expect(unknown.status).toBe(409);
    expect(unknown.json.error.code).toBe('E_REVISION_UNAVAILABLE');
    await t.run(['close', document.documentId, '--json']);
    const closed = await ui.api(`/documents/${document.documentId}/render-grants`, {
      method: 'POST',
      body: {},
    });
    expect(closed.status).toBe(404);
    // Issuing a grant requires a management session.
    const anonymous = await rawRequest(
      ui.origin,
      `/_/api/v1/documents/${document.documentId}/render-grants`,
      {
        method: 'POST',
        headers: { Origin: ui.origin, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(anonymous.status).toBe(401);
  });
});

describe('SEC-016 / SEC-017 responses of the preview listener', () => {
  it('attaches the load allowance only to assets such as fonts, not to the document', async () => {
    t.write('site/index.html', '<link rel="stylesheet" href="s.css"><img src="a.png"><p>本文</p>');
    t.write('site/s.css', '@font-face{font-family:f;src:url(f.woff2)}');
    t.write('site/f.woff2', Buffer.from('wOF2'));
    t.write('site/a.png', PNG);
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const withOrigin = (path: string) =>
      rawRequest(ui.previewOrigin, `${ui.filesPath(grant)}${path}`, {
        headers: { Origin: 'null' },
      });

    const html = await withOrigin('index.html');
    expect(html.status).toBe(200);
    expect(html.headers['access-control-allow-origin']).toBeUndefined();
    const csp = String(html.headers['content-security-policy']);
    const base = `${ui.previewOrigin}${ui.filesPath(grant).replace(/files\/$/, '')}`;
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      "script-src 'none'",
      `style-src 'unsafe-inline' ${base}`,
      `img-src ${base} data:`,
      `font-src ${base}`,
      "connect-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${ui.origin}`,
      'sandbox',
    ]);
    expect(csp).not.toContain('allow-');
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect(html.headers['cache-control']).toBe('no-store');
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');

    expect((await withOrigin('a.png')).headers['access-control-allow-origin']).toBeUndefined();
    for (const path of ['f.woff2', 's.css']) {
      const asset = await withOrigin(path);
      expect(asset.headers['access-control-allow-origin'], path).toBe('null');
      expect(asset.headers['access-control-allow-credentials'], path).toBeUndefined();
      expect(asset.headers['x-content-type-options'], path).toBe('nosniff');
    }
    // No allowance for URLs without a grant or unregistered paths.
    const missing = await withOrigin('missing.woff2');
    expect(missing.status).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBeUndefined();

    // The management API does not treat `Origin: null` as a management principal, and returns no allowance.
    for (const path of ['/_/api/v1/documents', '/_/api/v1/status']) {
      const response = await rawRequest(ui.origin, path, {
        headers: { Origin: 'null', Authorization: `Bearer ${ui.token}` },
      });
      expect(response.status, path).toBe(401);
      expect(response.headers['access-control-allow-origin'], path).toBeUndefined();
    }
    const uiPage = await rawRequest(ui.origin, '/', { headers: { Origin: 'null' } });
    expect(uiPage.headers['access-control-allow-origin']).toBeUndefined();
    // Does not answer preflight requests.
    const preflight = await rawRequest(ui.previewOrigin, `${ui.filesPath(grant)}f.woff2`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers only GET and HEAD, and returns neither the management API, the UI HTML, nor redirects', async () => {
    site('<img src="img/a.png">');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const files = ui.filesPath(grant);

    const head = await previewGet(ui, grant, 'index.html', 'HEAD');
    const get = await previewGet(ui, grant, 'index.html');
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    expect(head.headers['content-security-policy']).toBe(get.headers['content-security-policy']);
    // HEAD goes through the same grant check as GET.
    expect((await previewGet(ui, grant, 'secret.txt', 'HEAD')).status).toBe(404);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await previewGet(ui, grant, 'index.html', method);
      expect(response.status, method).toBe(405);
      expect(response.headers['allow'], method).toBe('GET, HEAD');
    }

    for (const path of [
      '/',
      '/index.html',
      '/assets/index.js',
      '/_/api/v1/status',
      '/_/api/v1/documents',
      '/_/api/v1/sessions/bootstrap',
      '/r',
      '/r/',
      files.replace(/files\/$/, ''),
      files.replace(/\/files\/$/, ''),
      files,
      `${files.replace(/files\/$/, '')}index.html`,
      '/favicon.ico',
    ]) {
      const response = await rawRequest(ui.previewOrigin, path, {
        headers: { Authorization: `Bearer ${ui.token}` },
      });
      expect(response.status, path).toBe(404);
      expect(response.headers['content-type'], path).toBe('text/plain; charset=utf-8');
      expect(response.headers['location'], path).toBeUndefined();
      expect(response.text, path).toBe('Not Found');
    }

    // Does not answer requests arriving with an aliased Host.
    const rebound = await rawRequest(ui.previewOrigin, `${files}index.html`, {
      headers: { Host: 'attacker.example' },
    });
    expect(rebound.status).toBe(404);
    const localhost = await rawRequest(ui.previewOrigin, `${files}index.html`, {
      headers: { Host: `localhost:${new URL(ui.previewOrigin).port}` },
    });
    expect(localhost.status).toBe(404);
  });

  it('does not leave the preview URL secret or the document path in the log', async () => {
    site('<img src="img/a.png">');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    await previewGet(ui, grant, 'index.html');
    await previewGet(ui, grant, 'secret-path-name.png');
    // The log is appended in order. Wait for the stop, then read the finished contents.
    await t.run(['daemon', 'stop', '--json']);
    const log = readFileSync(join(t.home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).toContain('preview.served');
    expect(log).toContain('preview.rejected');
    expect(log).not.toContain(grant.grant);
    expect(log).not.toContain('secret-path-name');
    expect(log).not.toContain(ui.token);
  });
});

describe('interactive (the interactive view)', () => {
  it('only allowed documents are served with a CSP permitting inline and registered scripts and requests to registered files', async () => {
    t.write('site/app.html', '<script>document.title = "x"</script><p>本文</p>');
    const document = await open(['site/app.html', '--html-mode', 'interactive']);
    const ui = await connectUi(t);
    const response = await ui.api<GrantData>(`/documents/${document.documentId}/render-grants`, {
      method: 'POST',
      body: { mode: 'interactive' },
    });
    expect(response.status).toBe(200);
    const grant = response.json.data;
    const html = await previewGet(ui, grant, 'app.html');
    expect(html.text).toContain('<script>document.title = "x"</script>');
    const csp = String(html.headers['content-security-policy']);
    const base = `${ui.previewOrigin}${ui.filesPath(grant).replace(/files\/$/, '')}`;
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      `script-src 'unsafe-inline' ${base}`,
      `style-src 'unsafe-inline' ${base}`,
      `img-src ${base} data:`,
      `font-src ${base}`,
      `connect-src ${base}`,
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${ui.origin}`,
      'sandbox allow-scripts',
    ]);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('unsafe-eval');
    // Even for the same document, the static view does not run scripts.
    const staticGrant = await ui.grant(document.documentId);
    const staticHtml = await previewGet(ui, staticGrant, 'app.html');
    expect(staticHtml.text).not.toContain('<script');
    expect(String(staticHtml.headers['content-security-policy'])).toContain("script-src 'none'");
  });

  it('an unallowed document gets no interactive view, and is not allowed without confirmation in the management UI', async () => {
    t.write('site/app.html', '<p>本文</p>');
    const document = await open(['site/app.html']);
    const ui = await connectUi(t);
    const refused = await ui.api(`/documents/${document.documentId}/render-grants`, {
      method: 'POST',
      body: { mode: 'interactive' },
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('E_INTERACTIVE_NOT_ALLOWED');
    const unconfirmed = await ui.api(`/documents/${document.documentId}/html-mode`, {
      method: 'POST',
      body: { mode: 'interactive' },
    });
    expect(unconfirmed.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    const enabled = await ui.api<{ interactiveAllowed: boolean }>(
      `/documents/${document.documentId}/html-mode`,
      { method: 'POST', body: { mode: 'interactive', confirmed: true } },
    );
    expect(enabled.json.data.interactiveAllowed).toBe(true);
    // After a restart, only the preference remains; the allowance is dropped until granted again.
    await t.run(['daemon', 'restart', '--json']);
    expect(await list()).toEqual([
      expect.objectContaining({ htmlMode: 'interactive', interactiveAllowed: false }),
    ]);
  });

  it('loading an unregistered file is 404, and only the session holding that render grant can fetch it as missing', async () => {
    t.write('site/app.html', '<p>本文</p>');
    t.write('site/secret.json', '{"secret":true}');
    const document = await open(['site/app.html', '--html-mode', 'interactive']);
    const ui = await connectUi(t);
    const grant = (
      await ui.api<GrantData>(`/documents/${document.documentId}/render-grants`, {
        method: 'POST',
        body: { mode: 'interactive' },
      })
    ).json.data;
    expect((await previewGet(ui, grant, 'secret.json')).status).toBe(404);
    const missing = await ui.api<{ missing: string[] }>('/render-grants/missing', {
      method: 'POST',
      body: { grant: grant.grant },
    });
    expect(missing.json.data.missing).toEqual(['secret.json']);
    const other = await connectUi(t);
    const hidden = await other.api<{ missing: string[] }>('/render-grants/missing', {
      method: 'POST',
      body: { grant: grant.grant },
    });
    expect(hidden.json.data.missing).toEqual([]);
  });
});

describe('rendering questions and draft answers from HTML (spec 12.2, 11.7)', () => {
  const questionnaire = {
    schemaVersion: 1,
    title: '確認',
    fieldOrder: ['layout'],
    answerSchema: {
      type: 'object',
      properties: { layout: { type: 'string', title: '採用案', enum: ['A', 'B'] } },
      required: ['layout'],
      additionalProperties: false,
    },
  };

  async function ask(args: string[]): Promise<{ requestId: string; revision: string }> {
    t.write('q.json', JSON.stringify(questionnaire));
    const result = await t.run(['ask', 'q.json', ...args, '--json']);
    return result.json<{ request: { requestId: string; revision: string } }>().data.request;
  }

  it('a render grant for a question is issued with the revision and view mode the question pinned', async () => {
    t.write('site/app.html', '<p>本文</p><script>document.title = "x"</script>');
    const interactive = await ask(['--view', 'site/app.html', '--html-mode', 'interactive']);
    t.write('site/plain.html', '<p>本文</p><script>document.title = "x"</script>');
    const plain = await ask(['--view', 'site/plain.html']);
    // Even if allowed after being created as static, the question view stays static.
    await open(['site/plain.html', '--html-mode', 'interactive']);
    const ui = await connectUi(t);
    const issue = (requestId: string) =>
      ui.api<GrantData & { mode: string; revision: string; bridge: unknown }>(
        `/feedback/${requestId}/render-grants`,
        { method: 'POST', body: {} },
      );
    const pinned = (await issue(interactive.requestId)).json.data;
    expect(pinned).toMatchObject({
      mode: 'interactive',
      revision: interactive.revision,
      bridge: { requestId: interactive.requestId },
    });
    const staticPinned = (await issue(plain.requestId)).json.data;
    expect(staticPinned).toMatchObject({ mode: 'static', bridge: null });
    expect((await previewGet(ui, staticPinned, 'plain.html')).text).not.toContain('<script');
    // Issuing a document view cannot specify a question.
    const refused = await ui.api('/documents/x/render-grants', {
      method: 'POST',
      body: { requestId: interactive.requestId },
    });
    expect(refused.status).toBe(400);
  });

  it('draft answer operations from HTML are accepted only while the render grant is valid, by the issuing session', async () => {
    t.write('site/app.html', '<p>本文</p>');
    const request = await ask(['--view', 'site/app.html', '--html-mode', 'interactive']);
    const ui = await connectUi(t);
    const { grant } = (
      await ui.api<GrantData>(`/feedback/${request.requestId}/render-grants`, {
        method: 'POST',
        body: {},
      })
    ).json.data;
    const ready = await ui.api<{ requestId: string; draftVersion: number }>(
      '/render-grants/bridge/ready',
      { method: 'POST', body: { grant } },
    );
    expect(ready.json.data).toMatchObject({ requestId: request.requestId, draftVersion: 0 });
    const saved = await ui.api<{ draftVersion: number }>('/render-grants/bridge/draft', {
      method: 'PUT',
      body: { grant, expectedDraftVersion: 0, answers: { layout: 'B' } },
    });
    expect(saved.json.data.draftVersion).toBe(1);
    // A replacement based on an old version is a conflict.
    const stale = await ui.api('/render-grants/bridge/draft', {
      method: 'PUT',
      body: { grant, expectedDraftVersion: 0, answers: { layout: 'A' } },
    });
    expect(stale.json.error.code).toBe('E_DRAFT_CONFLICT');
    // Unusable from another session.
    const other = await connectUi(t);
    const foreign = await other.api('/render-grants/bridge/ready', {
      method: 'POST',
      body: { grant },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error.code).toBe('E_RENDER_GRANT_INVALID');
    // After release, neither the view nor operations from HTML work.
    await ui.api('/render-grants/release', { method: 'POST', body: { grants: [grant] } });
    const released = await ui.api('/render-grants/bridge/draft', {
      method: 'PUT',
      body: { grant, expectedDraftVersion: 1, answers: { layout: 'A' } },
    });
    expect(released.status).toBe(403);
    expect(released.json.error.code).toBe('E_RENDER_GRANT_INVALID');
    const current = (await ui.api<{ draftAnswers: unknown }>(`/feedback/${request.requestId}`)).json
      .data;
    expect(current.draftAnswers).toEqual({ layout: 'B' });
  });
});

describe('SEC-019 opening documents from links in a document', () => {
  interface LinkResult {
    status: string;
    documentId: string;
  }
  const linkOpener =
    (ui: UiClient, documentId: string) => (linkId: string, body: Record<string, unknown>) =>
      ui.api<LinkResult>(`/documents/${documentId}/links/${linkId}/open`, {
        method: 'POST',
        body,
      });
  const titles = async () => (await list()).map((entry) => entry.title);

  it('opens an unregistered document only with confirmation', async () => {
    t.write(
      'site/index.html',
      `<a href="next.md">次の文書</a><a href="../outside-root.md">上の階層</a>
       <a href="https://example.com/">外部</a><a href="img/a.png">画像</a><a href="missing.md">存在しない</a>`,
    );
    t.write('site/next.md', '# 次の文書\n');
    t.write('outside-root.md', '# 上の階層の文書\n');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const { revision } = grant;
    expect(grant.links.map((link) => [link.linkId, link.kind])).toEqual([
      ['lnk_0001', 'document'],
      ['lnk_0002', 'document'],
      ['lnk_0003', 'external'],
      ['lnk_0004', 'other'],
      ['lnk_0005', 'document'],
    ]);
    const openLink = linkOpener(ui, document.documentId);

    // Without confirmation it does not open. Only the target path and a confirmation identifier are returned; the list does not change.
    const unconfirmed = await openLink('lnk_0001', { revision });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(String(unconfirmed.json.error.details['path'])).toMatch(/site\/next\.md$/);
    expect(unconfirmed.json.error.details['changed']).toBe(false);
    const confirmation = String(unconfirmed.json.error.details['confirmation']);
    expect(await titles()).toEqual(['index.html']);

    // Merely claiming "confirmed" does not open it. Only a server-issued confirmation identifier is valid.
    for (const forged of [{ confirmed: true }, { confirmation: 'true' }, { path: '/etc/hosts' }]) {
      const response = await openLink('lnk_0001', { revision, ...forged });
      expect(response.status, JSON.stringify(forged)).toBe(400);
    }
    // A confirmation for another link cannot be used.
    const other = await openLink('lnk_0002', { revision });
    const otherConfirmation = String(other.json.error.details['confirmation']);
    const crossed = await openLink('lnk_0001', { revision, confirmation: otherConfirmation });
    expect(crossed.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(crossed.json.error.details['changed']).toBe(true);
    expect(await titles()).toEqual(['index.html']);

    // With the issued confirmation, it opens.
    const confirmed = await openLink('lnk_0001', { revision, confirmation });
    expect(confirmed.json.data.status).toBe('opened');
    expect(await titles()).toEqual(['index.html', '次の文書']);
    // An already open document just gets focused, without confirmation.
    const again = await openLink('lnk_0001', { revision });
    expect(again.json.data).toEqual({
      status: 'focused',
      documentId: confirmed.json.data.documentId,
    });
    // A confirmation can be used once. Sending the same one after closing does not open.
    await t.run(['close', confirmed.json.data.documentId, '--json']);
    const reused = await openLink('lnk_0001', { revision, confirmation });
    expect(reused.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(await titles()).toEqual(['index.html']);

    // Even when it only focused, the given confirmation is consumed.
    const pending = String(reused.json.error.details['confirmation']);
    await open(['site/next.md']);
    const focused = await openLink('lnk_0001', { revision, confirmation: pending });
    expect(focused.json.data.status).toBe('focused');
    await t.run(['close', focused.json.data.documentId, '--json']);
    const afterFocus = await openLink('lnk_0001', { revision, confirmation: pending });
    expect(afterFocus.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(await titles()).toEqual(['index.html']);

    const unknown = await openLink('lnk_0099', { revision });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('E_LINK_NOT_FOUND');
    // Non-document links and external links do not open through this path.
    for (const linkId of ['lnk_0003', 'lnk_0004']) {
      expect((await openLink(linkId, { revision })).status, linkId).toBe(400);
    }
    // A missing document cannot be opened even with confirmation. Whether it exists is not revealed before confirmation.
    const missing = await openLink('lnk_0005', { revision });
    expect(missing.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    const missingConfirmed = await openLink('lnk_0005', {
      revision,
      confirmation: String(missing.json.error.details['confirmation']),
    });
    expect(missingConfirmed.status).toBe(404);
    expect(await titles()).toEqual(['index.html']);

    // A document outside the assets-root can also be opened after confirmation. Opening it does not widen the asset scope of the original document.
    const above = await openLink('lnk_0002', {
      revision,
      confirmation: String(
        (await openLink('lnk_0002', { revision })).json.error.details['confirmation'],
      ),
    });
    expect(above.json.data.status).toBe('opened');
    expect(assetPaths(document.documentId)).toEqual([]);
  });

  it('re-confirms when the document is updated and the target changes during confirmation', async () => {
    t.write('site/index.html', '<a href="first.md">link</a>');
    t.write('site/first.md', '# 最初の行き先\n');
    t.write('site/second.md', '# 変更後の行き先\n');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const openLink = linkOpener(ui, document.documentId);
    const before = await ui.grant(document.documentId);
    const asked = await openLink('lnk_0001', { revision: before.revision });
    const confirmation = String(asked.json.error.details['confirmation']);
    expect(String(asked.json.error.details['path'])).toMatch(/first\.md$/);

    // While the confirmation dialog is shown, the target of the link with the same number changes.
    t.write('site/index.html', '<a href="second.md">link</a>');
    await t.run(['refresh', '--json']);
    const after = await ui.grant(document.documentId);
    expect(after.revision).not.toBe(before.revision);

    // The old confirmation cannot be used for the new revision. The new target is shown and confirmation is asked again.
    const stale = await openLink('lnk_0001', { revision: after.revision, confirmation });
    expect(stale.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(stale.json.error.details['changed']).toBe(true);
    expect(String(stale.json.error.details['path'])).toMatch(/second\.md$/);
    expect(await titles()).toEqual(['index.html']);

    // Giving the confirmed revision and confirming again opens the confirmed target.
    const reasked = await openLink('lnk_0001', { revision: before.revision });
    const opened = await openLink('lnk_0001', {
      revision: before.revision,
      confirmation: String(reasked.json.error.details['confirmation']),
    });
    expect(opened.json.data.status).toBe('opened');
    expect(await titles()).toEqual(['index.html', '最初の行き先']);
  });

  it('re-confirms when the assets-root changes after confirmation and the target changes', async () => {
    // A link starting with `/` is relative to the assets-root. When the root changes, the target changes even for the same revision.
    t.write('site/index.html', '<a href="/docs/next.md">link</a>');
    t.write('site/docs/next.md', '# rootがsiteのときの行き先\n');
    t.write('docs/next.md', '# rootが上の階層のときの行き先\n');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const openLink = linkOpener(ui, document.documentId);
    const { revision } = await ui.grant(document.documentId);
    const asked = await openLink('lnk_0001', { revision });
    const confirmation = String(asked.json.error.details['confirmation']);
    expect(String(asked.json.error.details['path'])).toMatch(/site\/docs\/next\.md$/);

    const reopened = await open(['site/index.html', '--assets-root', '.']);
    expect(reopened.revision).toBe(revision);
    const stale = await openLink('lnk_0001', { revision, confirmation });
    expect(stale.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(stale.json.error.details['changed']).toBe(true);
    expect(String(stale.json.error.details['path'])).not.toMatch(/site\/docs\/next\.md$/);
    expect(await titles()).toEqual(['index.html']);
  });

  it('Markdown links go through the same confirmation', async () => {
    t.write(
      'docs/a.md',
      '# A\n\n[次](b.md) [外部](https://example.com/) [危険](javascript:alert(1))\n',
    );
    t.write('docs/b.md', '# B\n');
    const document = await open(['docs/a.md']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    expect(grant.documentUrl).toBeNull();
    expect(grant.links).toEqual([
      { linkId: 'lnk_0001', href: 'b.md', text: '次', kind: 'document' },
      { linkId: 'lnk_0002', href: 'https://example.com/', text: '外部', kind: 'external' },
    ]);
    const response = await linkOpener(ui, document.documentId)('lnk_0001', {
      revision: grant.revision,
    });
    expect(response.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(await titles()).toEqual(['A']);
  });
});

describe('Markdown images', () => {
  it('serves only registered local images, and does not fetch external images', async () => {
    const evil = await startBeacon();
    t.write(
      'docs/a.md',
      `# A\n\n![図](img/a.png) ![外部](${evil}/remote.png) ![無い](img/missing.png) ![上](../secret.png)\n`,
    );
    t.write('docs/img/a.png', PNG);
    t.write('secret.png', SECRET);
    const document = await open(['docs/a.md']);
    expect(assetPaths(document.documentId)).toEqual(['img/a.png']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    expect(grant.assets).toEqual([{ logicalPath: 'img/a.png', role: 'image' }]);
    expect(grant.documentLogicalPath).toBe('a.md');
    expect((await previewGet(ui, grant, 'img/a.png')).body.equals(PNG)).toBe(true);
    // Markdown is rendered by the main UI. The preview listener serves neither the source nor the converted result.
    expect((await previewGet(ui, grant, 'a.md')).status).toBe(404);
    expect(grant.diagnostics.map((entry) => [entry.code, entry.target]).toSorted()).toEqual(
      [
        ['asset-not-registered', 'img/missing.png'],
        ['asset-rejected', '../secret.png'],
        ['remote-asset-blocked', `${evil}/remote.png`],
      ].toSorted(),
    );
    expect(beaconHits).toEqual([]);
    expect(blobExists(SECRET)).toBe(false);
  });
});

describe('inheriting the assets-root, and document location', () => {
  it('documents found later by --watch also use the assets-root from registration', async () => {
    t.write('shared.css', '.shared{color:red}');
    const page = '<link rel="stylesheet" href="../shared.css"><p>page</p>';
    t.write('docs/first.html', page);
    const first = await open(['docs', '--watch', '--assets-root', '.']);
    expect(assetPaths(first.documentId)).toEqual(['shared.css']);
    const rule = (await t.run(['watch', 'list', '--json'])).json<{
      watchRules: Array<{ assetsRoot: string | null }>;
    }>().data.watchRules[0];
    expect(rule?.assetsRoot).toMatch(/work$/);

    // A document with the same content added later. Assets resolve within the same scope as the first document.
    t.write('docs/second.html', page);
    const added = await waitFor(list, (documents) => documents.length === 2);
    const second = added.find((entry) => entry.documentId !== first.documentId) as Summary;
    expect(assetPaths(second.documentId)).toEqual(['shared.css']);
    expect(currentRevision(second.documentId).documentLogicalPath).toBe('docs/second.html');

    // The same for a document added after a restart.
    await t.run(['daemon', 'restart', '--json']);
    t.write('docs/third.html', page);
    const afterRestart = await waitFor(list, (documents) => documents.length === 3);
    for (const entry of afterRestart) {
      expect(assetPaths(entry.documentId), entry.title).toEqual(['shared.css']);
    }
  });

  it('documents with the same content at different locations are rendered at their own locations', async () => {
    const page = '<img src="img/a.png"><p>同じ内容</p>';
    t.write('site/a.html', page);
    t.write('site/b.html', page);
    t.write('site/img/a.png', PNG);
    const a = await open(['site/a.html']);
    const b = await open(['site/b.html']);
    // The revision is determined by content, so it is the same. The served path differs per document.
    expect(b.revision).toBe(a.revision);
    const ui = await connectUi(t);
    const grantA = await ui.grant(a.documentId);
    const grantB = await ui.grant(b.documentId);
    expect(grantA.documentLogicalPath).toBe('a.html');
    expect(grantB.documentLogicalPath).toBe('b.html');
    expect(new URL(grantB.documentUrl as string).pathname).toMatch(/\/files\/b\.html$/);
    expect((await previewGet(ui, grantB, 'b.html')).status).toBe(200);
    expect((await previewGet(ui, grantB, 'a.html')).status).toBe(404);
    expect((await previewGet(ui, grantA, 'a.html')).status).toBe(200);
    expect((await previewGet(ui, grantA, 'b.html')).status).toBe(404);
  });

  it('errors when --asset is given for a stdin document without an assets-root', async () => {
    t.write('site/data.json', '{}');
    const result = await t.run(['open', '--format', 'html', '--asset', 'data.json', '--json'], {
      stdin: '<p>stdin</p>',
    });
    expect(result.exitCode).toBe(2);
    expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    expect(await list()).toEqual([]);
    const withRoot = await t.run(
      ['open', '--format', 'html', '--asset', 'data.json', '--assets-root', 'site', '--json'],
      { stdin: '<p>stdin</p>' },
    );
    expect(withRoot.exitCode).toBe(0);
  });
});

describe('asset limits', () => {
  it('a stdin document can use local files only when an assets-root is given', async () => {
    t.write('site/img/a.png', PNG);
    const html = '<img src="img/a.png"><p>stdin</p>';
    const without = await t.run(['open', '--format', 'html', '--key', 'k', '--json'], {
      stdin: html,
    });
    const documentId = without.json<{ documents: Summary[] }>().data.documents[0]
      ?.documentId as string;
    expect(assetPaths(documentId)).toEqual([]);

    const withRoot = await t.run(
      ['open', '--format', 'html', '--key', 'k', '--assets-root', 'site', '--json'],
      { stdin: html },
    );
    expect(withRoot.json<{ documents: Summary[] }>().data.documents[0]?.documentId).toBe(
      documentId,
    );
    expect(currentRevision(documentId)).toMatchObject({
      documentLogicalPath: 'index.html',
      assets: [{ logicalPath: 'img/a.png' }],
    });
  });

  it('errors when the document is outside the assets-root, or --html-mode is given for non-HTML', async () => {
    site('<p>本文</p>');
    t.write('elsewhere/a.html', '<p>別の場所</p>');
    t.write('docs/a.md', '# A\n');
    const outsideRoot = await t.run([
      'open',
      'elsewhere/a.html',
      '--assets-root',
      'site',
      '--json',
    ]);
    expect(outsideRoot.exitCode).toBe(2);
    expect(outsideRoot.json().error.code).toBe('E_INVALID_ARGUMENT');
    const notDirectory = await t.run([
      'open',
      'site/index.html',
      '--assets-root',
      'site/index.html',
      '--json',
    ]);
    expect(notDirectory.exitCode).toBe(2);
    const mode = await t.run(['open', 'docs/a.md', '--html-mode', 'static', '--json']);
    expect(mode.exitCode).toBe(2);
    const unknownMode = await t.run([
      'open',
      'site/index.html',
      '--html-mode',
      'dynamic',
      '--json',
    ]);
    expect(unknownMode.exitCode).toBe(2);
    const several = await t.run([
      'open',
      'site/index.html',
      'elsewhere/a.html',
      '--asset',
      'img/a.png',
      '--json',
    ]);
    expect(several.exitCode).toBe(2);
    expect(await list()).toEqual([]);

    expect(
      (await t.run(['open', 'site/index.html', '--html-mode', 'static', '--json'])).exitCode,
    ).toBe(0);
  });

  it('does not register a document with one asset exceeding the limit', async () => {
    t.write('site/index.html', '<img src="big.png">');
    t.write('site/big.png', Buffer.alloc(20 * 1024 * 1024 + 1));
    const result = await t.run(['open', 'site/index.html', '--json']);
    expect(result.exitCode).toBe(7);
    expect(result.json().error.code).toBe('E_LIMIT_EXCEEDED');
    expect(await list()).toEqual([]);
  });
});
