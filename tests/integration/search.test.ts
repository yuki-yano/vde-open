import { chmodSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestHome, type TestHome } from './harness.ts';

const fixtures = fileURLToPath(new URL('../fixtures/search', import.meta.url));

interface Hit {
  documentId: string;
  revision: string;
  title: string;
  displayPath: string | null;
  sectionId: string;
  headingPath: string[];
  excerpt: string;
  matchKind: string;
  sourceRange: unknown;
  extraction: string;
}
interface Search {
  registeredDocuments: number;
  searchedDocuments: number;
  incomplete: boolean;
  failedDocuments: Array<{ documentId: string; code: string }>;
  indexingDocuments: string[];
  hits: Hit[];
  truncated: boolean;
  nextCursor: string | null;
  catalogVersion: number;
  indexedAt: string;
}
interface Read {
  revision: string;
  mode: string;
  content?: string;
  outline?: Array<{ sectionId: string; title: string }>;
  sectionId?: string;
  sourceRange: unknown;
  extraction: string;
  truncated: boolean;
  nextCursor: string | null;
}

let t: TestHome;
const ids = new Map<string, string>();

beforeEach(async () => {
  t = createTestHome();
  cpSync(fixtures, t.work, { recursive: true });
  ids.clear();
  // unopened.mdは開かない。
  const opened = await t.run([
    'open',
    'auth.md',
    'design-notes.md',
    'api/users.md',
    'ops/runbook.md',
    '--json',
  ]);
  for (const document of opened.json<{
    documents: Array<{ documentId: string; displayPath: string }>;
  }>().data.documents) {
    ids.set(document.displayPath, document.documentId);
  }
});

afterEach(async () => {
  await t.cleanup();
});

const search = async (...args: string[]) =>
  (await t.run(['search', ...args, '--json'])).json<Search>();
const read = async (...args: string[]) => (await t.run(['read', ...args, '--json'])).json<Read>();
const paths = (result: Search) => result.hits.map((hit) => hit.displayPath);

describe('SRCH-001 / SRCH-002 検索の対象', () => {
  it('開いている文書だけを検索し、閉じた文書は直後から出ない', async () => {
    const found = (await search('認証', '--limit', '10')).data;
    expect(found.registeredDocuments).toBe(4);
    expect(found.searchedDocuments).toBe(4);
    expect(found.incomplete).toBe(false);
    expect(new Set(paths(found))).toEqual(new Set(['auth.md', 'design-notes.md']));
    // 同じdirectoryにあっても、開いていない文書は検索しない。
    expect(JSON.stringify(found)).not.toContain('開いていない文書');
    expect((await t.run(['list', '--json'])).stdout).not.toContain('unopened');

    // 閉じた直後の検索に、閉じた文書は出ない。
    await t.run(['close', ids.get('auth.md') as string, '--json']);
    const after = (await search('認証', '--limit', '10')).data;
    expect(paths(after)).toEqual(['design-notes.md']);
    expect(after.registeredDocuments).toBe(3);
    expect((await search('refresh_token')).data.hits).toEqual([]);
    // 閉じた文書を名指ししても、検索できない。
    const closed = await t.run([
      'search',
      '認証',
      '--document',
      ids.get('auth.md') as string,
      '--json',
    ]);
    expect(closed.exitCode).toBe(3);
    expect(closed.json().error.code).toBe('E_DOCUMENT_NOT_OPEN');
  });

  it('日本語、identifier、検索の種類、対象の絞り込みが、CLIから使える', async () => {
    expect((await search('有効期限')).data.hits[0]).toMatchObject({
      displayPath: 'auth.md',
      sectionId: 'sec_0002',
      headingPath: ['認証仕様', 'セッションの有効期限'],
      extraction: 'markdown',
      // 解析結果に原文の位置がないので、推測した行番号は返さない（SRCH-012）。
      sourceRange: null,
    });
    expect(paths((await search('セッション 有効期限', '--mode', 'exact')).data)).toEqual([]);
    expect(paths((await search('users.md', '--mode', 'path')).data)).toEqual(['api/users.md']);
    const scoped = await search('有効期限', '--document', ids.get('ops/runbook.md') as string);
    expect(paths(scoped.data)).toEqual(['ops/runbook.md']);
    expect(scoped.data.registeredDocuments).toBe(1);
    // 抜粋は、抽出した本文の実際の一部（SRCH-016）。
    const hit = (await search('refresh_token')).data.hits[0] as Hit;
    const section = (await read(hit.documentId, '--section', hit.sectionId)).data.content ?? '';
    expect(section.replace(/\s+/g, ' ')).toContain(hit.excerpt);
    // 通常の表示。
    const text = await t.run(['search', '認証']);
    expect(text.stdout).toContain('認証仕様');
    expect(text.stdout).toContain('検索した文書 4件');
    const bad = await t.run(['search', '認証', '--mode', 'regex', '--json']);
    expect(bad.exitCode).toBe(2);
  });
});

describe('SRCH-007 検索した版の取得', () => {
  it('検索の後で原本が変わっても、検索結果の版を指定すれば、検索時の内容を返す', async () => {
    const hit = (await search('refresh_token')).data.hits[0] as Hit;
    writeFileSync(join(t.work, 'auth.md'), '# 認証仕様\n\n書き換えた後の内容。\n');
    await t.run(['refresh', '--json']);

    const pinned = (
      await read(hit.documentId, '--section', hit.sectionId, '--revision', hit.revision)
    ).data;
    expect(pinned.revision).toBe(hit.revision);
    expect(pinned.content).toContain('refresh_token');
    // 版を指定しなければ、現在の版。検索時の節は、現在の版にはない。
    const current = await t.run(['read', hit.documentId, '--section', hit.sectionId, '--json']);
    expect(current.exitCode).toBe(3);
    expect(current.json().error.code).toBe('E_SECTION_NOT_FOUND');
    // 保持していない版は、現在の版で代用しない。
    const unknown = await t.run([
      'read',
      hit.documentId,
      '--revision',
      `rev_${'0'.repeat(64)}`,
      '--json',
    ]);
    expect(unknown.exitCode).toBe(4);
    expect(unknown.json().error.code).toBe('E_REVISION_UNAVAILABLE');
    // 更新後の内容は、新しい版として検索できる。前の内容では見つからない。
    expect((await search('refresh_token')).data.hits).toEqual([]);
    expect((await search('書き換えた')).data.hits[0]?.revision).not.toBe(hit.revision);
  });
});

describe('SRCH-008 / SRCH-009 検索のcursor', () => {
  it('一覧が変わったら、続きを取れない。改ざんや流用も拒否する', async () => {
    const first = (await search('認証', '--limit', '1')).data;
    expect(first.hits).toHaveLength(1);
    expect(first.truncated).toBe(true);
    const cursor = first.nextCursor as string;

    // 続きは、前のpageと重ならず、抜けもない。
    const second = (await search('認証', '--limit', '1', '--cursor', cursor)).data;
    expect(second.hits).toHaveLength(1);
    const all = (await search('認証', '--limit', '10')).data.hits;
    expect([first.hits[0]?.sectionId, second.hits[0]?.sectionId]).toEqual(
      all.slice(0, 2).map((hit) => hit.sectionId),
    );

    // 別のquery、別の条件、別の操作のcursorは使えない。
    const otherQuery = await t.run([
      'search',
      '設計',
      '--limit',
      '1',
      '--cursor',
      cursor,
      '--json',
    ]);
    expect(otherQuery.json().error.code).toBe('E_INVALID_CURSOR');
    const otherMode = await t.run([
      'search',
      '認証',
      '--limit',
      '1',
      '--mode',
      'exact',
      '--cursor',
      cursor,
      '--json',
    ]);
    expect(otherMode.json().error.code).toBe('E_INVALID_CURSOR');
    const listCursor = (await t.run(['list', '--limit', '1', '--json'])).json<{
      nextCursor: string;
    }>().data.nextCursor;
    const crossed = await t.run([
      'search',
      '認証',
      '--limit',
      '1',
      '--cursor',
      listCursor,
      '--json',
    ]);
    expect(crossed.exitCode).toBe(4);
    expect(crossed.json().error.code).toBe('E_INVALID_CURSOR');
    const asList = await t.run(['list', '--cursor', cursor, '--json']);
    expect(asList.json().error.code).toBe('E_INVALID_CURSOR');
    // 中身を書き換えたcursor。
    const [body, signature] = cursor.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), offset: 0 }),
    ).toString('base64url');
    const tampered = await t.run([
      'search',
      '認証',
      '--limit',
      '1',
      '--cursor',
      `${forged}.${signature}`,
      '--json',
    ]);
    expect(tampered.json().error.code).toBe('E_INVALID_CURSOR');

    // 一覧が変わったら、続きは取れない。抜けや重なりを、黙って返さない。
    t.write('extra.md', '# 追加\n\n認証の話。\n');
    await t.run(['open', 'extra.md', '--json']);
    const stale = await t.run(['search', '認証', '--limit', '1', '--cursor', cursor, '--json']);
    expect(stale.exitCode).toBe(4);
    expect(stale.json().error.code).toBe('E_CURSOR_STALE');
  });
});

describe('SRCH-010 --max-bytes', () => {
  it('長い1行を、文字の途中で切らずに分けて返し、つなぐと元の内容になる', async () => {
    const line = `${'認証の有効期限を延ばす😀'.repeat(200)}`;
    t.write('long.md', `# ${'長い見出し'.repeat(80)}\n\n${line}\n`);
    const documentId = (await t.run(['open', 'long.md', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents[0]?.documentId as string;

    for (const mode of [[], ['--section', 'sec_0001']]) {
      let content = '';
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Read = (
          await read(
            documentId,
            '--max-bytes',
            '256',
            ...(cursor === null ? mode : ['--cursor', cursor]),
          )
        ).data;
        // 位置は毎回進む。文字の途中で切れていない。
        expect((page.content ?? '').length).toBeGreaterThan(0);
        expect(Buffer.byteLength(page.content ?? '')).toBeLessThanOrEqual(256);
        expect(page.content).not.toContain('�');
        content += page.content ?? '';
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBeGreaterThan(10);
      expect(content).toContain(line);
      expect(content.startsWith(mode.length === 0 ? '# 長い見出し' : '長い見出し')).toBe(true);
    }

    // 256未満は指定できない。
    for (const command of [
      ['read', documentId, '--max-bytes', '255'],
      ['search', '認証', '--max-bytes', '255'],
    ]) {
      const result = await t.run([...command, '--json']);
      expect(result.exitCode, command.join(' ')).toBe(2);
      expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    }

    // 1つの要素が予算に収まらないときは、空の結果ではなく、必要な大きさを返す。
    const outline = await t.run(['read', documentId, '--outline', '--max-bytes', '256', '--json']);
    expect(outline.exitCode).toBe(7);
    expect(outline.json().error.code).toBe('E_MAX_BYTES_TOO_SMALL');
    const required = outline.json().error.details['requiredBytes'] as number;
    expect(required).toBeGreaterThan(256);
    const enough = (await read(documentId, '--outline', '--max-bytes', String(required))).data;
    expect(enough.outline).toHaveLength(1);
    expect(enough.truncated).toBe(false);

    const tooSmall = await t.run(['search', '延ばす', '--max-bytes', '256', '--json']);
    expect(tooSmall.exitCode).toBe(7);
    expect(tooSmall.json().error.code).toBe('E_MAX_BYTES_TOO_SMALL');
    const needed = tooSmall.json().error.details['requiredBytes'] as number;
    expect((await search('延ばす', '--max-bytes', String(needed))).data.hits).toHaveLength(1);
  });

  it('見出しの一覧と検索結果は、要素を分割せずに、続きをcursorで返す', async () => {
    const headings = Array.from(
      { length: 40 },
      (_, n) => `## 節${String(n)}\n\n本文${String(n)}。\n`,
    );
    t.write('many.md', `# 多い\n\n${headings.join('\n')}`);
    const documentId = (await t.run(['open', 'many.md', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents[0]?.documentId as string;
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Read = (
        await read(
          documentId,
          '--max-bytes',
          '512',
          ...(cursor === null ? ['--outline'] : ['--cursor', cursor]),
        )
      ).data;
      expect(page.mode).toBe('outline');
      expect(Buffer.byteLength(JSON.stringify(page.outline))).toBeLessThanOrEqual(512);
      expect(page.outline?.length).toBeGreaterThan(0);
      collected.push(...(page.outline ?? []).map((item) => item.sectionId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(collected).toHaveLength(41);
    // 節のIDは、版の中で重ならない（SRCH-014）。
    expect(new Set(collected).size).toBe(41);
    // cursorは、取得の種類に固定される。別の種類の指定とは併用できない。
    const first = (await read(documentId, '--outline', '--max-bytes', '512')).data;
    const mixed = await t.run([
      'read',
      documentId,
      '--section',
      'sec_0001',
      '--cursor',
      first.nextCursor as string,
      '--json',
    ]);
    expect(mixed.exitCode).toBe(2);
    const both = await t.run(['read', documentId, '--outline', '--section', 'sec_0001', '--json']);
    expect(both.exitCode).toBe(2);
  });
});

describe('SRCH-011 原文の行と範囲', () => {
  it('CRLF、末尾の改行、空の文書、行の範囲の境界を、物理行とbyte位置で返す', async () => {
    t.write('crlf.md', '一行目\r\n二行目\r\n三行目');
    t.write('empty.md', '');
    const opened = (await t.run(['open', 'crlf.md', 'empty.md', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents;
    const crlf = opened[0]?.documentId as string;
    const empty = opened[1]?.documentId as string;

    const whole = (await read(crlf)).data;
    expect(whole.content).toBe('一行目\r\n二行目\r\n三行目');
    expect(whole.sourceRange).toEqual({
      startByte: 0,
      endByteExclusive: 31,
      lineStart: 1,
      lineEnd: 3,
    });
    // 行は物理行。CRLFは1つの改行として数え、原文のまま返す。
    const second = (await read(crlf, '--lines', '2:2')).data;
    expect(second.content).toBe('二行目\r\n');
    expect(second.sourceRange).toEqual({
      startByte: 11,
      endByteExclusive: 22,
      lineStart: 2,
      lineEnd: 2,
    });
    expect((await read(crlf, '--lines', '3:3')).data.content).toBe('三行目');
    const beyond = await t.run(['read', crlf, '--lines', '4:4', '--json']);
    expect(beyond.exitCode).toBe(2);

    // 空の文書は、1つの空行として扱う。
    const blank = (await read(empty, '--lines', '1:1')).data;
    expect(blank.content).toBe('');
    expect((await t.run(['read', empty, '--lines', '2:2', '--json'])).exitCode).toBe(2);
    // 末尾の改行の後に、行を足して数えない。
    t.write('trailing.md', 'a\nb\n');
    const trailing = (await t.run(['open', 'trailing.md', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents[0]?.documentId as string;
    expect((await read(trailing, '--lines', '2:2')).data.content).toBe('b\n');
    expect((await t.run(['read', trailing, '--lines', '3:3', '--json'])).exitCode).toBe(2);
  });
});

describe('SRCH-013 HTMLの抽出', () => {
  it('scriptの内容、入力欄の値、scriptが作る本文は、検索にも節の取得にも出ない', async () => {
    t.write(
      'page.html',
      `<!doctype html><title>画面の案</title><script>const key = "SCRIPT-SECRET-VALUE";
       document.body.innerHTML = "<p>scriptが作る文</p>";</script>
       <h1>ログイン</h1><p>静的に書かれた本文。</p>
       <input value="INPUT-SECRET-VALUE"><textarea>TEXTAREA-SECRET-VALUE</textarea>`,
    );
    const documentId = (await t.run(['open', 'page.html', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents[0]?.documentId as string;
    const found = (await search('静的に書かれた')).data.hits[0] as Hit;
    // 静的に抽出した結果であることを示す。
    expect(found).toMatchObject({
      displayPath: 'page.html',
      extraction: 'static-html',
      sourceRange: null,
    });
    for (const hidden of [
      'SCRIPT-SECRET-VALUE',
      'INPUT-SECRET-VALUE',
      'TEXTAREA-SECRET-VALUE',
      'scriptが作る文',
    ]) {
      expect((await search(hidden, '--mode', 'exact')).data.hits, hidden).toEqual([]);
    }
    const section = (await read(documentId, '--section', 'sec_0001')).data;
    expect(section).toMatchObject({
      mode: 'section',
      sectionId: 'sec_0001',
      extraction: 'static-html',
    });
    expect(section.content).toBe('ログイン\n\n静的に書かれた本文。');
    // 原文は、別に取得できる。
    expect((await read(documentId)).data.content).toContain('SCRIPT-SECRET-VALUE');
  });
});

describe('SRCH-015 / DOC-012 検索できない文書', () => {
  it('解析できない文書があれば、全件を検索したとは答えない', async () => {
    t.write('deep.md', `${'> '.repeat(70)}深すぎる引用。認証。\n`);
    const deep = (await t.run(['open', 'deep.md', '--json'])).json<{
      documents: Array<{ documentId: string; searchState: string }>;
    }>().data.documents[0]?.documentId as string;
    const found = (await search('認証', '--limit', '10')).data;
    expect(found.incomplete).toBe(true);
    expect(found.failedDocuments).toEqual([{ documentId: deep, code: 'E_PARSE_FAILED' }]);
    expect(found.registeredDocuments).toBe(5);
    expect(found.searchedDocuments).toBe(4);
    // 検索できた文書の結果は返す。
    expect(new Set(paths(found))).toEqual(new Set(['auth.md', 'design-notes.md']));
    const listed = (await t.run(['list', '--json'])).json<{
      documents: Array<{ documentId: string; searchState: string }>;
    }>().data.documents;
    expect(listed.find((entry) => entry.documentId === deep)?.searchState).toBe('excluded');
    expect(listed.filter((entry) => entry.searchState === 'ready')).toHaveLength(4);
  });

  it('読めなくなった文書の前の内容を、いまの検索結果として返さない', async () => {
    const auth = ids.get('auth.md') as string;
    rmSync(join(t.work, 'auth.md'));
    await t.run(['refresh', '--json']);
    const missing = (await search('refresh_token')).data;
    expect(missing.hits).toEqual([]);
    expect(missing.incomplete).toBe(true);
    expect(missing.failedDocuments).toEqual([{ documentId: auth, code: 'source-missing' }]);
    const listed = (await t.run(['list', '--json'])).json<{
      documents: Array<{ documentId: string; sourceState: string; searchState: string }>;
    }>().data.documents;
    expect(listed.find((entry) => entry.documentId === auth)).toMatchObject({
      sourceState: 'missing',
      searchState: 'excluded',
    });

    // 読む権限がなくなった文書も同じ。
    chmodSync(join(t.work, 'design-notes.md'), 0o000);
    await t.run(['refresh', '--json']);
    const unreadable = (await search('Bearer')).data;
    expect(unreadable.hits).toEqual([]);
    expect(unreadable.failedDocuments.map((entry) => entry.code).toSorted()).toEqual([
      'source-missing',
      'source-unreadable',
    ]);
    chmodSync(join(t.work, 'design-notes.md'), 0o644);

    // 戻れば、また検索できる。
    cpSync(join(fixtures, 'auth.md'), join(t.work, 'auth.md'));
    await t.run(['refresh', '--json']);
    const back = (await search('refresh_token')).data;
    expect(paths(back)).toEqual(['auth.md']);
    expect(back.incomplete).toBe(false);
  });
});
