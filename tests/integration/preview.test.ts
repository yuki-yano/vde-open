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
  // 作業directoryの隣。assets-rootの外にある秘密のfile。
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

// 届いたrequestを記録するだけのserver。backendやbrowserが外部へ要求していないことを確かめる。
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
  if (!envelope.ok) throw new Error(`openに失敗: ${JSON.stringify(envelope.error)}`);
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
    if (Date.now() > deadline) throw new Error(`条件を満たしません: ${JSON.stringify(value)}`);
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

describe('DOC-011 参照しているfileと文書の版', () => {
  it('同じ内容の再保存では版が変わらず、CSSだけの変更で版が変わる', async () => {
    site('<link rel="stylesheet" href="css/site.css"><img src="img/a.png"><p>本文</p>');
    const first = await open(['site/index.html']);
    expect(assetPaths(first.documentId)).toEqual(['css/site.css', 'img/a.png']);

    // 本文もassetも同じ内容で保存し直す。
    writeFileSync(join(t.work, 'site/index.html'), readFileSync(join(t.work, 'site/index.html')));
    writeFileSync(join(t.work, 'site/css/site.css'), '.a{background:url(../img/a.png)}');
    await t.run(['refresh', '--json']);
    expect((await list())[0]?.revision).toBe(first.revision);

    // CSSだけを変える。本文は同じでも、別の版になる。監視が追従する。
    writeFileSync(join(t.work, 'site/css/site.css'), '.a{color:red}');
    const changed = await waitFor(list, (documents) => documents[0]?.revision !== first.revision);
    expect(changed[0]?.documentId).toBe(first.documentId);
    // CSSが参照しなくなった画像は、HTMLが参照しているので残る。
    expect(assetPaths(first.documentId)).toEqual(['css/site.css', 'img/a.png']);

    // 参照されているが存在しなかったfileが作られたら、取り込む。
    t.write('site/index.html', '<img src="img/a.png"><img src="img/later.png">');
    await waitFor(list, (documents) => documents[0]?.revision !== changed[0]?.revision);
    expect(assetPaths(first.documentId)).toEqual(['img/a.png']);
    t.write('site/img/later.png', PNG);
    await waitFor(
      () => Promise.resolve(assetPaths(first.documentId)),
      (paths) => paths.includes('img/later.png'),
    );
  });

  it('前の版を指定すると、その版のassetで表示する', async () => {
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

describe('SEC-009 assets-rootの外を指す参照', () => {
  it('登録の時点で、rootの外のfileを読まない', async () => {
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

  it('--assetでも、rootの外や、解釈の分かれる指定は登録できない', async () => {
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
    // 失敗したopenは、文書を登録していない。
    expect(await list()).toEqual([]);
    expect(blobExists(SECRET)).toBe(false);
  });

  it('配信の時点でも、rootの外や未登録のpathへ到達できない', async () => {
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

describe('SEC-010 assets-rootの中の、登録していないfile', () => {
  it('存在を知らせず、directoryの一覧も返さない', async () => {
    site('<img src="img/a.png"><img src=".env"><img src=".git/logo.png">');
    t.write('site/secret.txt', SECRET);
    t.write('site/.env', `KEY=${SECRET}`);
    t.write('site/.git/logo.png', PNG);
    t.write('site/img/private.png', Buffer.concat([PNG, Buffer.from('private')]));
    t.write('site/data.json', `{"secret":"${SECRET}"}`);
    t.write('site/app.js', `const secret = "${SECRET}";`);
    const document = await open(['site/index.html']);
    // 文書が参照していても、`.`で始まる名前のfileは登録しない。
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
      // 存在するfileも、しないfileも、権限のないURLも、同じ応答になる。
      expect(response.status, path).toBe(404);
      expect(response.text, path).toBe(unknownGrant.text);
      expect(response.headers['content-type'], path).toBe(unknownGrant.headers['content-type']);
    }
  });

  it('個別に指定したfileだけが加わり、同じdirectoryの他のfileは公開されない', async () => {
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

    // 指定なしで開き直しても、登録済みの指定は保たれる。
    await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['data.json']);
  });
});

describe('SEC-011 symlinkによるrootの外への到達', () => {
  it('rootの外を指すsymlinkを、fileでもdirectoryでも読まない', async () => {
    site('<img src="img/a.png"><img src="link.png"><img src="linked/secret.png">');
    symlinkSync(join(outside, 'secret.png'), join(t.work, 'site/link.png'));
    symlinkSync(outside, join(t.work, 'site/linked'));
    // rootの中を指すsymlinkは読める。
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

  it('rootの中でも、秘密のfileや別の種類のfileを指すsymlinkは読まない', async () => {
    t.write('site/.env', `KEY=${SECRET}`);
    t.write('site/.git/secret.png', `${SECRET}-git`);
    t.write('site/private.json', `{"secret":"${SECRET}"}`);
    t.write('site/notes.txt', `${SECRET}-text`);
    t.write('site/img/a.png', PNG);
    // 画像やCSSの名前を付けたsymlink。指している実体は、登録してはいけないfile。
    symlinkSync(join(t.work, 'site/.env'), join(t.work, 'site/public.png'));
    symlinkSync(join(t.work, 'site/.git/secret.png'), join(t.work, 'site/logo.png'));
    symlinkSync(join(t.work, 'site/private.json'), join(t.work, 'site/data.png'));
    symlinkSync(join(t.work, 'site/notes.txt'), join(t.work, 'site/style.css'));
    symlinkSync(join(t.work, 'site/.git'), join(t.work, 'site/assets'));
    // 同じ種類の、公開してよいfileを指すsymlinkは読める。
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

    // 個別に指定しても、秘密のfileを指すsymlinkは登録できない。
    for (const asset of ['public.png', 'logo.png', 'data.png']) {
      const result = await t.run(['open', 'site/index.html', '--asset', asset, '--json']);
      expect(result.exitCode, asset).toBe(5);
    }
    // JSONは、個別に指定したときだけ登録できる。JSONを指すJSONのsymlinkも同じ。
    symlinkSync(join(t.work, 'site/private.json'), join(t.work, 'site/alias.json'));
    await open(['site/index.html', '--asset', 'alias.json']);
    expect(assetPaths(document.documentId)).toEqual(['alias.json', 'alias.png']);
  });

  it('登録の後でdirectoryがrootの外へ差し替えられても、外のfileを読まない', async () => {
    site('<img src="img/a.png">');
    const document = await open(['site/index.html']);
    writeFileSync(join(outside, 'a.png'), SECRET);

    // 画像のdirectoryを、rootの外を指すsymlinkへ差し替える。
    renameSync(join(t.work, 'site/img'), join(t.work, 'site/img-original'));
    symlinkSync(outside, join(t.work, 'site/img'));
    await t.run(['refresh', '--json']);
    expect(assetPaths(document.documentId)).toEqual([]);
    expect(blobExists(SECRET)).toBe(false);

    // rootそのものを差し替える。文書は読めない状態になり、差し替え先の内容は取り込まない。
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

describe('SEC-012 CSSの外部参照と循環', () => {
  it('外部のURLをbackendが取得せず、変換後のCSSにも残さない', async () => {
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
    // custom propertyに書いた文字列は、それだけでは取得されないので残る。
    // その値をURLとして使う宣言（image-set(var(--image))）の側を無効化している。
    expect(css).toContain('--image:"');
    expect(css.replace(/--image:"[^"]*"/, '')).not.toContain('127.0.0.1');
    expect(css).toContain('.a{color:red}');
    expect(css).toContain('.b{background:url(../img/a.png)}');
    // 名前をescapeで書いた@importと宣言、変数からURLを差し込むimage-setは、無効化する。
    expect(css).not.toContain('mport');
    expect(css).not.toContain('image-set');
    expect(css).not.toContain('escaped-property');
    expect(css).toContain('color:blue');
    expect(css).toContain('.d{margin:0}');
    expect(grant.diagnostics.map((entry) => entry.code)).toContain('css-invalid');
    expect(grant.diagnostics.filter((entry) => entry.code === 'remote-asset-blocked').length).toBe(
      7,
    );
    // 登録から配信までの間に、外部への要求は1件も出ていない。
    expect(beaconHits).toEqual([]);
  });

  it('互いを読み込むCSSでも、登録が終わる', async () => {
    t.write('site/index.html', '<link rel="stylesheet" href="a.css">');
    t.write('site/a.css', '@import "b.css"; .a{color:red}');
    t.write('site/b.css', '@import "a.css"; @import "c/c.css"; .b{color:blue}');
    t.write('site/c/c.css', '@import "../a.css"; .c{background:url(../img/a.png)}');
    t.write('site/img/a.png', PNG);
    const document = await open(['site/index.html']);
    expect(assetPaths(document.documentId)).toEqual(['a.css', 'b.css', 'c/c.css', 'img/a.png']);
  });

  it('CSSの読み込みの深さには上限があり、その先は登録しない', async () => {
    t.write('site/index.html', '<link rel="stylesheet" href="s0.css">');
    for (let depth = 0; depth < 12; depth += 1) {
      t.write(`site/s${String(depth)}.css`, `@import "s${String(depth + 1)}.css";`);
    }
    const document = await open(['site/index.html']);
    // 文書から直接読むs0と、そこから8段先まで。
    expect(assetPaths(document.documentId)).toHaveLength(9);
  });
});

describe('SEC-014 SVG', () => {
  it('画像として参照したSVGだけを登録し、scriptを動かせないheaderで配信する', async () => {
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

    // 直接開いても、SVGの中のscriptは動かない（sandboxとscript禁止のpolicy）。
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

describe('SEC-015 表示用の権限の失効', () => {
  it('閉じた文書、破棄したsession、再起動の後は、発行済みのURLで読めない', async () => {
    site('<img src="img/a.png">');
    t.write('other/index.html', '<p>別の文書</p>');
    const document = await open(['site/index.html']);
    const other = await open(['other/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    const otherGrant = await ui.grant(other.documentId);
    expect((await previewGet(ui, grant, 'index.html')).status).toBe(200);

    // 権限は、発行した文書の中だけで使える。別の文書のfileは読めない。
    expect((await previewGet(ui, otherGrant, 'img/a.png')).status).toBe(404);
    // 管理APIの認証には使えない。管理のtokenを、表示用のURLとして使うこともできない。
    const asToken = await rawRequest(ui.origin, '/_/api/v1/documents', {
      headers: { Authorization: `Bearer ${grant.grant}` },
    });
    expect(asToken.status).toBe(401);
    expect((await rawRequest(ui.previewOrigin, `/r/${ui.token}/files/index.html`)).status).toBe(
      404,
    );
    expect((await rawRequest(ui.origin, `${ui.filesPath(grant)}index.html`)).status).toBe(404);

    // 自分で返した権限は、すぐに使えなくなる。
    const released = await ui.api<{ released: number }>('/render-grants/release', {
      method: 'POST',
      body: { grants: [otherGrant.grant] },
    });
    expect(released.json.data.released).toBe(1);
    expect((await previewGet(ui, otherGrant, 'index.html')).status).toBe(404);

    // 別のsessionは、他のsessionの権限を返せない。
    const second = await connectUi(t);
    const stolen = await second.api<{ released: number }>('/render-grants/release', {
      method: 'POST',
      body: { grants: [grant.grant] },
    });
    expect(stolen.json.data.released).toBe(0);
    expect((await previewGet(ui, grant, 'index.html')).status).toBe(200);

    // 文書を閉じると失効する。閉じている間に一度も使わなくても、開き直した後に前の権限は戻らない。
    const unused = await ui.grant(document.documentId);
    await t.run(['close', document.documentId, '--json']);
    await open(['site/index.html']);
    expect((await previewGet(ui, unused, 'index.html')).status).toBe(404);
    expect((await previewGet(ui, grant, 'index.html')).status).toBe(404);

    // sessionを破棄すると、そのsessionが発行した権限も失効する。
    const fresh = await ui.grant(document.documentId);
    expect((await previewGet(ui, fresh, 'index.html')).status).toBe(200);
    await ui.api('/session', { method: 'DELETE' });
    expect((await previewGet(ui, fresh, 'index.html')).status).toBe(404);

    // daemonを再起動すると、前の権限は使えない。
    const third = await connectUi(t);
    const beforeRestart = await third.grant(document.documentId);
    await t.run(['daemon', 'restart', '--json']);
    const restarted = await connectUi(t);
    expect(
      (await rawRequest(restarted.previewOrigin, `${third.filesPath(beforeRestart)}index.html`))
        .status,
    ).toBe(404);
  });

  it('権限は、文書を表示する版に結び付く', async () => {
    site('<p>版1</p>');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const first = await ui.grant(document.documentId);
    t.write('site/index.html', '<p>版2</p>');
    await t.run(['refresh', '--json']);
    const second = await ui.grant(document.documentId);
    // 前の権限は、前の版を表示し続ける。新しい版には、新しい権限が要る。
    expect((await previewGet(ui, first, 'index.html')).text).toContain('版1');
    expect((await previewGet(ui, second, 'index.html')).text).toContain('版2');

    // 保持していない版や、開いていない文書の権限は発行しない。
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
    // 権限の発行には、管理のsessionが要る。
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

describe('SEC-016 / SEC-017 表示用listenerの応答', () => {
  it('文書には読み込みの許可を付けず、fontなどのassetにだけ付ける', async () => {
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
    // 権限のないURLと未登録のpathには、許可を付けない。
    const missing = await withOrigin('missing.woff2');
    expect(missing.status).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBeUndefined();

    // `Origin: null`は、管理APIでは管理の主体として扱わず、許可も返さない。
    for (const path of ['/_/api/v1/documents', '/_/api/v1/status']) {
      const response = await rawRequest(ui.origin, path, {
        headers: { Origin: 'null', Authorization: `Bearer ${ui.token}` },
      });
      expect(response.status, path).toBe(401);
      expect(response.headers['access-control-allow-origin'], path).toBeUndefined();
    }
    const uiPage = await rawRequest(ui.origin, '/', { headers: { Origin: 'null' } });
    expect(uiPage.headers['access-control-allow-origin']).toBeUndefined();
    // 事前確認（preflight）には応じない。
    const preflight = await rawRequest(ui.previewOrigin, `${ui.filesPath(grant)}f.woff2`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GETとHEADだけに応じ、管理APIも、UIのHTMLも、redirectも返さない', async () => {
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
    // HEADも、GETと同じ権限の確認を通る。
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

    // 別名のHostで届いたrequestには応じない。
    const rebound = await rawRequest(ui.previewOrigin, `${files}index.html`, {
      headers: { Host: 'attacker.example' },
    });
    expect(rebound.status).toBe(404);
    const localhost = await rawRequest(ui.previewOrigin, `${files}index.html`, {
      headers: { Host: `localhost:${new URL(ui.previewOrigin).port}` },
    });
    expect(localhost.status).toBe(404);
  });

  it('表示用URLの秘密と、文書のpathを、logへ残さない', async () => {
    site('<img src="img/a.png">');
    const document = await open(['site/index.html']);
    const ui = await connectUi(t);
    const grant = await ui.grant(document.documentId);
    await previewGet(ui, grant, 'index.html');
    await previewGet(ui, grant, 'secret-path-name.png');
    // logは順に追記される。停止を待って、書き終えた内容を読む。
    await t.run(['daemon', 'stop', '--json']);
    const log = readFileSync(join(t.home, 'logs', 'daemon.jsonl'), 'utf8');
    expect(log).toContain('preview.served');
    expect(log).toContain('preview.rejected');
    expect(log).not.toContain(grant.grant);
    expect(log).not.toContain('secret-path-name');
    expect(log).not.toContain(ui.token);
  });
});

describe('interactive（scriptを動かす表示）', () => {
  it('許可した文書だけ、inlineと登録済みのscriptと、登録済みfileへの通信を許すCSPで配信する', async () => {
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
    // 同じ文書でも、staticの表示はscriptを動かさない。
    const staticGrant = await ui.grant(document.documentId);
    const staticHtml = await previewGet(ui, staticGrant, 'app.html');
    expect(staticHtml.text).not.toContain('<script');
    expect(String(staticHtml.headers['content-security-policy'])).toContain("script-src 'none'");
  });

  it('許可していない文書は、interactiveの表示を発行せず、管理UIの確認なしには許可しない', async () => {
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
    // 再起動の後は、希望だけが残り、許可は付け直すまで外れる。
    await t.run(['daemon', 'restart', '--json']);
    expect(await list()).toEqual([
      expect.objectContaining({ htmlMode: 'interactive', interactiveAllowed: false }),
    ]);
  });

  it('登録されていないfileの読み込みは404で、その表示の権限を持つsessionだけが不足として取得できる', async () => {
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

describe('質問の表示とHTMLからの回答案（仕様12.2、11.7）', () => {
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

  it('質問の表示の権限は、質問が固定した版と表示方法で発行する', async () => {
    t.write('site/app.html', '<p>本文</p><script>document.title = "x"</script>');
    const interactive = await ask(['--view', 'site/app.html', '--html-mode', 'interactive']);
    t.write('site/plain.html', '<p>本文</p><script>document.title = "x"</script>');
    const plain = await ask(['--view', 'site/plain.html']);
    // staticで作った後に許可しても、質問の表示はstatic。
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
    // 文書の表示の発行では、質問を指定できない。
    const refused = await ui.api('/documents/x/render-grants', {
      method: 'POST',
      body: { requestId: interactive.requestId },
    });
    expect(refused.status).toBe(400);
  });

  it('HTMLからの回答案の操作は、表示の権限が有効な間だけ、発行したsessionで受け付ける', async () => {
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
    // 古い版をもとにした置き換えは競合。
    const stale = await ui.api('/render-grants/bridge/draft', {
      method: 'PUT',
      body: { grant, expectedDraftVersion: 0, answers: { layout: 'A' } },
    });
    expect(stale.json.error.code).toBe('E_DRAFT_CONFLICT');
    // 別のsessionからは使えない。
    const other = await connectUi(t);
    const foreign = await other.api('/render-grants/bridge/ready', {
      method: 'POST',
      body: { grant },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error.code).toBe('E_RENDER_GRANT_INVALID');
    // 返却した後は、表示もHTMLからの操作も使えない。
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

describe('SEC-019 文書中のlinkから文書を開く', () => {
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

  it('未登録の文書は、確認があるときだけ開く', async () => {
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

    // 確認がなければ開かない。開く対象のpathと、確認の識別子を返すだけで、一覧は変わらない。
    const unconfirmed = await openLink('lnk_0001', { revision });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(String(unconfirmed.json.error.details['path'])).toMatch(/site\/next\.md$/);
    expect(unconfirmed.json.error.details['changed']).toBe(false);
    const confirmation = String(unconfirmed.json.error.details['confirmation']);
    expect(await titles()).toEqual(['index.html']);

    // 「確認した」と名乗るだけでは開けない。確認の識別子は、serverが発行したものだけが有効。
    for (const forged of [{ confirmed: true }, { confirmation: 'true' }, { path: '/etc/hosts' }]) {
      const response = await openLink('lnk_0001', { revision, ...forged });
      expect(response.status, JSON.stringify(forged)).toBe(400);
    }
    // 別のlinkの確認は使えない。
    const other = await openLink('lnk_0002', { revision });
    const otherConfirmation = String(other.json.error.details['confirmation']);
    const crossed = await openLink('lnk_0001', { revision, confirmation: otherConfirmation });
    expect(crossed.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(crossed.json.error.details['changed']).toBe(true);
    expect(await titles()).toEqual(['index.html']);

    // 発行された確認を付けると開く。
    const confirmed = await openLink('lnk_0001', { revision, confirmation });
    expect(confirmed.json.data.status).toBe('opened');
    expect(await titles()).toEqual(['index.html', '次の文書']);
    // すでに開いている文書は、確認なしで表示を切り替えるだけ。
    const again = await openLink('lnk_0001', { revision });
    expect(again.json.data).toEqual({
      status: 'focused',
      documentId: confirmed.json.data.documentId,
    });
    // 確認は1回だけ使える。閉じた後に同じ確認を送っても、開かない。
    await t.run(['close', confirmed.json.data.documentId, '--json']);
    const reused = await openLink('lnk_0001', { revision, confirmation });
    expect(reused.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(await titles()).toEqual(['index.html']);

    // 表示の切り替えで終わった場合も、渡した確認は使い終える。
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
    // 文書でないlinkと、外部のlinkは、この経路では開かない。
    for (const linkId of ['lnk_0003', 'lnk_0004']) {
      expect((await openLink(linkId, { revision })).status, linkId).toBe(400);
    }
    // 存在しない文書は、確認があっても開けない。存在するかどうかは、確認の前には答えない。
    const missing = await openLink('lnk_0005', { revision });
    expect(missing.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    const missingConfirmed = await openLink('lnk_0005', {
      revision,
      confirmation: String(missing.json.error.details['confirmation']),
    });
    expect(missingConfirmed.status).toBe(404);
    expect(await titles()).toEqual(['index.html']);

    // assets-rootの外の文書も、確認を経れば開ける。開いても、元の文書のassetの範囲は広がらない。
    const above = await openLink('lnk_0002', {
      revision,
      confirmation: String(
        (await openLink('lnk_0002', { revision })).json.error.details['confirmation'],
      ),
    });
    expect(above.json.data.status).toBe('opened');
    expect(assetPaths(document.documentId)).toEqual([]);
  });

  it('確認している間に文書が更新されて行き先が変わったら、確認し直す', async () => {
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

    // 確認の画面を出している間に、同じ番号のlinkの行き先が変わる。
    t.write('site/index.html', '<a href="second.md">link</a>');
    await t.run(['refresh', '--json']);
    const after = await ui.grant(document.documentId);
    expect(after.revision).not.toBe(before.revision);

    // 新しい版に対して、前の確認は使えない。新しい行き先を示して、確認し直す。
    const stale = await openLink('lnk_0001', { revision: after.revision, confirmation });
    expect(stale.json.error.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(stale.json.error.details['changed']).toBe(true);
    expect(String(stale.json.error.details['path'])).toMatch(/second\.md$/);
    expect(await titles()).toEqual(['index.html']);

    // 確認した版を指定して、あらためて確認すれば、確認した行き先が開く。
    const reasked = await openLink('lnk_0001', { revision: before.revision });
    const opened = await openLink('lnk_0001', {
      revision: before.revision,
      confirmation: String(reasked.json.error.details['confirmation']),
    });
    expect(opened.json.data.status).toBe('opened');
    expect(await titles()).toEqual(['index.html', '最初の行き先']);
  });

  it('確認の後でassets-rootが変わって行き先が変わったら、確認し直す', async () => {
    // `/`で始まるlinkは、assets-rootからの指定。rootが変わると、同じ版でも行き先が変わる。
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

  it('Markdownのlinkも、同じ確認を通る', async () => {
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

describe('Markdownの画像', () => {
  it('登録済みのlocalの画像だけを配信し、外部の画像は取得しない', async () => {
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
    // Markdownは本体で描画する。表示用のlistenerからは、原文も変換結果も配信しない。
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

describe('assets-rootの引き継ぎと、文書の位置', () => {
  it('--watchで後から見つけた文書にも、登録時のassets-rootを使う', async () => {
    t.write('shared.css', '.shared{color:red}');
    const page = '<link rel="stylesheet" href="../shared.css"><p>page</p>';
    t.write('docs/first.html', page);
    const first = await open(['docs', '--watch', '--assets-root', '.']);
    expect(assetPaths(first.documentId)).toEqual(['shared.css']);
    const rule = (await t.run(['watch', 'list', '--json'])).json<{
      watchRules: Array<{ assetsRoot: string | null }>;
    }>().data.watchRules[0];
    expect(rule?.assetsRoot).toMatch(/work$/);

    // 後から追加した、同じ内容の文書。最初の文書と同じ範囲でassetを解決する。
    t.write('docs/second.html', page);
    const added = await waitFor(list, (documents) => documents.length === 2);
    const second = added.find((entry) => entry.documentId !== first.documentId) as Summary;
    expect(assetPaths(second.documentId)).toEqual(['shared.css']);
    expect(currentRevision(second.documentId).documentLogicalPath).toBe('docs/second.html');

    // 再起動の後に追加した文書も同じ。
    await t.run(['daemon', 'restart', '--json']);
    t.write('docs/third.html', page);
    const afterRestart = await waitFor(list, (documents) => documents.length === 3);
    for (const entry of afterRestart) {
      expect(assetPaths(entry.documentId), entry.title).toEqual(['shared.css']);
    }
  });

  it('同じ内容の文書が別の位置にあるとき、それぞれの位置で表示する', async () => {
    const page = '<img src="img/a.png"><p>同じ内容</p>';
    t.write('site/a.html', page);
    t.write('site/b.html', page);
    t.write('site/img/a.png', PNG);
    const a = await open(['site/a.html']);
    const b = await open(['site/b.html']);
    // 版は内容で決まるので同じ。配信するpathは、文書ごとに違う。
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

  it('assets-rootのないstdinの文書に--assetを指定したら、errorにする', async () => {
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

describe('assetの上限', () => {
  it('stdinの文書は、assets-rootを指定したときだけlocal fileを使える', async () => {
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

  it('文書がassets-rootの外にあるとき、--html-modeがHTML以外のときは、errorにする', async () => {
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

  it('1つのassetが上限を超える文書は、登録しない', async () => {
    t.write('site/index.html', '<img src="big.png">');
    t.write('site/big.png', Buffer.alloc(20 * 1024 * 1024 + 1));
    const result = await t.run(['open', 'site/index.html', '--json']);
    expect(result.exitCode).toBe(7);
    expect(result.json().error.code).toBe('E_LIMIT_EXCEEDED');
    expect(await list()).toEqual([]);
  });
});
