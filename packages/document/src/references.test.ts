import { describe, expect, it } from 'vitest';

import {
  assetTypeOf,
  classifyLink,
  classifyReference,
  hasHiddenSegment,
  isRelativeReference,
  isValidLogicalPath,
  relativeUrlTo,
  roleAllowed,
} from './references.ts';

const NUL = String.fromCharCode(0);

describe('SEC-009 reference classification', () => {
  it('resolves relative references from the document into paths relative to the assets-root', () => {
    expect(classifyReference('img/a.png', '')).toEqual({
      kind: 'local',
      logicalPath: 'img/a.png',
      suffix: '',
    });
    expect(classifyReference('../img/a.png?v=1#x', 'docs/guide')).toEqual({
      kind: 'local',
      logicalPath: 'docs/img/a.png',
      suffix: '?v=1#x',
    });
    // A leading `/` means relative to the assets-root, whatever the document's location.
    expect(classifyReference('/css/site.css', 'docs/guide')).toMatchObject({
      logicalPath: 'css/site.css',
    });
    expect(classifyReference('./a/./b//c.png', '')).toMatchObject({ logicalPath: 'a/b/c.png' });
    // Japanese and spaces. The same path whether encoded or not.
    expect(classifyReference('%E5%9B%B3/a%20b.png', '')).toMatchObject({
      logicalPath: '図/a b.png',
    });
    expect(classifyReference('図/a b.png', '')).toMatchObject({ logicalPath: '図/a b.png' });
    // As in browsers, surrounding whitespace and newlines inside are ignored.
    expect(classifyReference('  img/\na.png\t ', '')).toMatchObject({ logicalPath: 'img/a.png' });
  });

  it('rejects references pointing outside the assets-root', () => {
    for (const url of [
      '../a.png',
      'a/../../b.png',
      '/../a.png',
      '%2e%2e/a.png',
      'x/%2E%2E/%2e%2e/a',
    ]) {
      expect(classifyReference(url, ''), url).toEqual({ kind: 'rejected', reason: 'outside-root' });
    }
    // Even when the document is below the root, going above the root is rejected.
    expect(classifyReference('../../a.png', 'docs')).toEqual({
      kind: 'rejected',
      reason: 'outside-root',
    });
  });

  it('rejects encoded separators or NUL, and double encoding', () => {
    for (const url of [
      '..%2fsecret.png',
      'a%2Fb.png',
      'a%5cb.png',
      'a%00.png',
      '%252e%252e/a.png',
      'a%252fb.png',
      '%zz.png',
      '%E3%81.png',
    ]) {
      expect(classifyReference(url, ''), url).toEqual({ kind: 'rejected', reason: 'encoded' });
    }
    expect(classifyReference(`a${NUL}.png`, '')).toEqual({ kind: 'rejected', reason: 'nul' });
  });

  it('rejects filesystem paths, UNC, file: and other schemes', () => {
    expect(classifyReference('file:///etc/passwd', '')).toEqual({
      kind: 'rejected',
      reason: 'file-url',
    });
    expect(classifyReference('FILE://server/share/a.png', '')).toMatchObject({
      reason: 'file-url',
    });
    for (const url of [
      '\\\\server\\share\\a.png',
      'a\\b.png',
      '..\\a.png',
      '/\\evil.example/a.png',
    ]) {
      expect(classifyReference(url, ''), url).toEqual({ kind: 'rejected', reason: 'backslash' });
    }
    for (const url of [
      'C:/Users/a.png',
      'c:\\a.png',
      'javascript:alert(1)',
      'blob:x',
      'about:blank',
    ]) {
      expect(classifyReference(url, '').kind, url).toBe('rejected');
    }
    // A leading `/` is not treated as an absolute filesystem path. It points only inside the assets-root.
    expect(classifyReference('/etc/passwd', '')).toEqual({
      kind: 'local',
      logicalPath: 'etc/passwd',
      suffix: '',
    });
  });

  it('distinguishes external URLs, data URLs, in-document references and empty references', () => {
    for (const url of ['http://e.example/a.png', 'HTTPS://e.example/a.png', '//e.example/a.png']) {
      expect(classifyReference(url, ''), url).toEqual({ kind: 'remote' });
    }
    expect(classifyReference('data:image/PNG;base64,AAAA', '')).toEqual({
      kind: 'data',
      mime: 'image/png',
    });
    expect(classifyReference('data:,x', '')).toEqual({ kind: 'data', mime: '' });
    expect(classifyReference('#top', '')).toEqual({ kind: 'fragment' });
    for (const url of ['', '   ', '?x=1']) {
      expect(classifyReference(url, ''), url).toEqual({ kind: 'rejected', reason: 'empty' });
    }
    for (const url of ['img/', '.', './', 'a/..']) {
      expect(classifyReference(url, 'docs'), url).toEqual({
        kind: 'rejected',
        reason: 'directory',
      });
    }
  });

  it('checks the form of a logical path', () => {
    expect(isValidLogicalPath('a/b.png')).toBe(true);
    for (const path of ['', '/a.png', 'a//b.png', '../a.png', 'a/./b.png', 'a\\b.png', `a${NUL}`]) {
      expect(isValidLogicalPath(path), path).toBe(false);
    }
  });
});

describe('asset types', () => {
  it('decides the type by extension, and null for unsupported', () => {
    expect(assetTypeOf('a/b.PNG')).toEqual({ mime: 'image/png', role: 'image' });
    expect(assetTypeOf('a.svg')?.role).toBe('svg');
    expect(assetTypeOf('a.mjs')?.role).toBe('script');
    expect(assetTypeOf('data.json')?.role).toBe('data');
    for (const path of ['.env', 'id_rsa', 'key.pem', 'a.html', 'a.mp4', 'noext', 'a.png.exe']) {
      expect(assetTypeOf(path), path).toBeNull();
    }
  });

  it('limits the usable roles per context', () => {
    expect(roleAllowed('image', 'svg')).toBe(true);
    expect(roleAllowed('image', 'script')).toBe(false);
    expect(roleAllowed('style', 'image')).toBe(false);
    expect(roleAllowed('script', 'data')).toBe(false);
    expect(roleAllowed('css-url', 'font')).toBe(true);
    // References found by document analysis never register data. Only an explicit asset can register it.
    for (const context of ['image', 'style', 'script', 'font', 'css-url'] as const) {
      expect(roleAllowed(context, 'data')).toBe(false);
    }
    expect(roleAllowed('explicit', 'data')).toBe(true);
  });

  it('detects paths containing a name starting with `.`', () => {
    expect(hasHiddenSegment('.git/config')).toBe(true);
    expect(hasHiddenSegment('a/.env')).toBe(true);
    expect(hasHiddenSegment('a/b.png')).toBe(false);
  });

  it('builds relative URLs', () => {
    expect(relativeUrlTo('', 'css/a b.css')).toBe('css/a%20b.css');
    expect(relativeUrlTo('docs/guide', 'img/図.png')).toBe('../../img/%E5%9B%B3.png');
  });
});

describe('link classification', () => {
  it('distinguishes external URLs, in-document links, local documents and links that cannot be opened', () => {
    expect(classifyLink('https://e.example/a')).toEqual({
      kind: 'external',
      url: 'https://e.example/a',
    });
    expect(classifyLink('mailto:a@e.example').kind).toBe('external');
    expect(classifyLink('#sec')).toEqual({ kind: 'fragment' });
    expect(classifyLink('../other/b.md#sec')).toEqual({
      kind: 'document',
      fromRoot: false,
      segments: ['..', 'other', 'b.md'],
    });
    expect(classifyLink('/docs/a.HTML?x')).toEqual({
      kind: 'document',
      fromRoot: true,
      segments: ['docs', 'a.HTML'],
    });
    for (const href of [
      'javascript:alert(1)',
      'file:///a.md',
      '//e.example/a.md',
      'a.png',
      'dir/',
      '..',
      'a%2fb.md',
      '\\\\server\\a.md',
      'data:text/html,x',
      '',
    ]) {
      expect(classifyLink(href).kind, href).toBe('other');
    }
  });

  it('detects the form of a relative reference', () => {
    for (const url of ['a.png', './a.png', '../a.png', '/a.png', 'a b.png']) {
      expect(isRelativeReference(url), url).toBe(true);
    }
    for (const url of ['http://e/a.png', '//e/a.png', 'data:image/png,x', '#a', '', 'a\\b.png']) {
      expect(isRelativeReference(url), url).toBe(false);
    }
  });
});
