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

describe('SEC-009 参照の分類', () => {
  it('文書からの相対参照を、assets-rootからの相対pathへ解決する', () => {
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
    // `/`始まりは、文書の位置によらずassets-rootからの指定。
    expect(classifyReference('/css/site.css', 'docs/guide')).toMatchObject({
      logicalPath: 'css/site.css',
    });
    expect(classifyReference('./a/./b//c.png', '')).toMatchObject({ logicalPath: 'a/b/c.png' });
    // 日本語と空白。encodeされていても、されていなくても同じpath。
    expect(classifyReference('%E5%9B%B3/a%20b.png', '')).toMatchObject({
      logicalPath: '図/a b.png',
    });
    expect(classifyReference('図/a b.png', '')).toMatchObject({ logicalPath: '図/a b.png' });
    // browserと同じく、前後の空白と途中の改行は無視する。
    expect(classifyReference('  img/\na.png\t ', '')).toMatchObject({ logicalPath: 'img/a.png' });
  });

  it('assets-rootの外を指す参照を拒否する', () => {
    for (const url of [
      '../a.png',
      'a/../../b.png',
      '/../a.png',
      '%2e%2e/a.png',
      'x/%2E%2E/%2e%2e/a',
    ]) {
      expect(classifyReference(url, ''), url).toEqual({ kind: 'rejected', reason: 'outside-root' });
    }
    // 文書がrootより下にあっても、rootを越える分は拒否する。
    expect(classifyReference('../../a.png', 'docs')).toEqual({
      kind: 'rejected',
      reason: 'outside-root',
    });
  });

  it('区切りやNULのencode、二重のencodeを拒否する', () => {
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

  it('filesystemのpath、UNC、file:、その他のschemeを拒否する', () => {
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
    // `/`始まりは、filesystemの絶対pathとしては扱わない。assets-rootの中だけを指す。
    expect(classifyReference('/etc/passwd', '')).toEqual({
      kind: 'local',
      logicalPath: 'etc/passwd',
      suffix: '',
    });
  });

  it('外部のURL、data URL、文書内の参照、空の参照を区別する', () => {
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

  it('logical pathの形を確かめる', () => {
    expect(isValidLogicalPath('a/b.png')).toBe(true);
    for (const path of ['', '/a.png', 'a//b.png', '../a.png', 'a/./b.png', 'a\\b.png', `a${NUL}`]) {
      expect(isValidLogicalPath(path), path).toBe(false);
    }
  });
});

describe('assetの種別', () => {
  it('拡張子で種別を決め、対応外はnull', () => {
    expect(assetTypeOf('a/b.PNG')).toEqual({ mime: 'image/png', role: 'image' });
    expect(assetTypeOf('a.svg')?.role).toBe('svg');
    expect(assetTypeOf('a.mjs')?.role).toBe('script');
    expect(assetTypeOf('data.json')?.role).toBe('data');
    for (const path of ['.env', 'id_rsa', 'key.pem', 'a.html', 'a.mp4', 'noext', 'a.png.exe']) {
      expect(assetTypeOf(path), path).toBeNull();
    }
  });

  it('文脈ごとに使える種別を限る', () => {
    expect(roleAllowed('image', 'svg')).toBe(true);
    expect(roleAllowed('image', 'script')).toBe(false);
    expect(roleAllowed('style', 'image')).toBe(false);
    expect(roleAllowed('script', 'data')).toBe(false);
    expect(roleAllowed('css-url', 'font')).toBe(true);
    // 文書の解析で見つけた参照からは、dataを登録しない。個別の指定でだけ登録できる。
    for (const context of ['image', 'style', 'script', 'font', 'css-url'] as const) {
      expect(roleAllowed(context, 'data')).toBe(false);
    }
    expect(roleAllowed('explicit', 'data')).toBe(true);
  });

  it('`.`で始まる名前を含むpathを見分ける', () => {
    expect(hasHiddenSegment('.git/config')).toBe(true);
    expect(hasHiddenSegment('a/.env')).toBe(true);
    expect(hasHiddenSegment('a/b.png')).toBe(false);
  });

  it('相対URLを作る', () => {
    expect(relativeUrlTo('', 'css/a b.css')).toBe('css/a%20b.css');
    expect(relativeUrlTo('docs/guide', 'img/図.png')).toBe('../../img/%E5%9B%B3.png');
  });
});

describe('linkの分類', () => {
  it('外部のURL、文書内、localの文書、開けないlinkを区別する', () => {
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

  it('相対参照の形を見分ける', () => {
    for (const url of ['a.png', './a.png', '../a.png', '/a.png', 'a b.png']) {
      expect(isRelativeReference(url), url).toBe(true);
    }
    for (const url of ['http://e/a.png', '//e/a.png', 'data:image/png,x', '#a', '', 'a\\b.png']) {
      expect(isRelativeReference(url), url).toBe(false);
    }
  });
});
