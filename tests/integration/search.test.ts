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
  // unopened.md is not opened.
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

describe('SRCH-001 / SRCH-002 search scope', () => {
  it('searches only open documents, and a closed document disappears immediately', async () => {
    const found = (await search('認証', '--limit', '10')).data;
    expect(found.registeredDocuments).toBe(4);
    expect(found.searchedDocuments).toBe(4);
    expect(found.incomplete).toBe(false);
    expect(new Set(paths(found))).toEqual(new Set(['auth.md', 'design-notes.md']));
    // A document that is not open is not searched even if it is in the same directory.
    expect(JSON.stringify(found)).not.toContain('開いていない文書');
    expect((await t.run(['list', '--json'])).stdout).not.toContain('unopened');

    // A search right after closing does not return the closed document.
    await t.run(['close', ids.get('auth.md') as string, '--json']);
    const after = (await search('認証', '--limit', '10')).data;
    expect(paths(after)).toEqual(['design-notes.md']);
    expect(after.registeredDocuments).toBe(3);
    expect((await search('refresh_token')).data.hits).toEqual([]);
    // Naming a closed document explicitly does not make it searchable.
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

  it('Japanese, identifiers, search modes, and scope narrowing are usable from the CLI', async () => {
    expect((await search('有効期限')).data.hits[0]).toMatchObject({
      displayPath: 'auth.md',
      sectionId: 'sec_0002',
      headingPath: ['認証仕様', 'セッションの有効期限'],
      extraction: 'markdown',
      // The parse result has no source positions, so no guessed line numbers are returned (SRCH-012).
      sourceRange: null,
    });
    expect(paths((await search('セッション 有効期限', '--mode', 'exact')).data)).toEqual([]);
    expect(paths((await search('users.md', '--mode', 'path')).data)).toEqual(['api/users.md']);
    const scoped = await search('有効期限', '--document', ids.get('ops/runbook.md') as string);
    expect(paths(scoped.data)).toEqual(['ops/runbook.md']);
    expect(scoped.data.registeredDocuments).toBe(1);
    // The excerpt is an actual part of the extracted body (SRCH-016).
    const hit = (await search('refresh_token')).data.hits[0] as Hit;
    const section = (await read(hit.documentId, '--section', hit.sectionId)).data.content ?? '';
    expect(section.replace(/\s+/g, ' ')).toContain(hit.excerpt);
    // Normal output.
    const text = await t.run(['search', '認証']);
    expect(text.stdout).toContain('認証仕様');
    expect(text.stdout).toContain('searched documents: 4');
    const bad = await t.run(['search', '認証', '--mode', 'regex', '--json']);
    expect(bad.exitCode).toBe(2);
  });
});

describe('SRCH-007 reading the searched revision', () => {
  it('returns the content at search time when the revision from the hit is given, even if the source changed afterwards', async () => {
    const hit = (await search('refresh_token')).data.hits[0] as Hit;
    writeFileSync(join(t.work, 'auth.md'), '# 認証仕様\n\n書き換えた後の内容。\n');
    await t.run(['refresh', '--json']);

    const pinned = (
      await read(hit.documentId, '--section', hit.sectionId, '--revision', hit.revision)
    ).data;
    expect(pinned.revision).toBe(hit.revision);
    expect(pinned.content).toContain('refresh_token');
    // Without a revision, the current one. The section from the search does not exist in the current revision.
    const current = await t.run(['read', hit.documentId, '--section', hit.sectionId, '--json']);
    expect(current.exitCode).toBe(3);
    expect(current.json().error.code).toBe('E_SECTION_NOT_FOUND');
    // An unretained revision is not substituted with the current one.
    const unknown = await t.run([
      'read',
      hit.documentId,
      '--revision',
      `rev_${'0'.repeat(64)}`,
      '--json',
    ]);
    expect(unknown.exitCode).toBe(4);
    expect(unknown.json().error.code).toBe('E_REVISION_UNAVAILABLE');
    // The updated content is searchable as a new revision. The old content is no longer found.
    expect((await search('refresh_token')).data.hits).toEqual([]);
    expect((await search('書き換えた')).data.hits[0]?.revision).not.toBe(hit.revision);
  });
});

describe('SRCH-008 / SRCH-009 search cursor', () => {
  it('cannot continue once the list changes; tampering and reuse are rejected too', async () => {
    const first = (await search('認証', '--limit', '1')).data;
    expect(first.hits).toHaveLength(1);
    expect(first.truncated).toBe(true);
    const cursor = first.nextCursor as string;

    // The continuation neither overlaps the previous page nor skips anything.
    const second = (await search('認証', '--limit', '1', '--cursor', cursor)).data;
    expect(second.hits).toHaveLength(1);
    const all = (await search('認証', '--limit', '10')).data.hits;
    expect([first.hits[0]?.sectionId, second.hits[0]?.sectionId]).toEqual(
      all.slice(0, 2).map((hit) => hit.sectionId),
    );

    // A cursor cannot be used with a different query, different conditions, or a different operation.
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
    // A cursor with modified contents.
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

    // Once the list changes, no continuation. Gaps or overlaps are not returned silently.
    t.write('extra.md', '# 追加\n\n認証の話。\n');
    await t.run(['open', 'extra.md', '--json']);
    const stale = await t.run(['search', '認証', '--limit', '1', '--cursor', cursor, '--json']);
    expect(stale.exitCode).toBe(4);
    expect(stale.json().error.code).toBe('E_CURSOR_STALE');
  });
});

describe('SRCH-010 --max-bytes', () => {
  it('splits a long single line without cutting a character, and joined, it reproduces the original', async () => {
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
        // The position advances every time. No character is cut in the middle.
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

    // Less than 256 cannot be given.
    for (const command of [
      ['read', documentId, '--max-bytes', '255'],
      ['search', '認証', '--max-bytes', '255'],
    ]) {
      const result = await t.run([...command, '--json']);
      expect(result.exitCode, command.join(' ')).toBe(2);
      expect(result.json().error.code).toBe('E_INVALID_ARGUMENT');
    }

    // When one element does not fit the budget, the required size is returned instead of an empty result.
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

  it('the outline and search results continue with a cursor without splitting elements', async () => {
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
    // Section IDs are unique within a revision (SRCH-014).
    expect(new Set(collected).size).toBe(41);
    // A cursor is bound to the kind of read. It cannot be combined with a different kind.
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

describe('SRCH-011 source lines and ranges', () => {
  it('returns CRLF, trailing newline, empty document, and line range boundaries as physical lines and byte positions', async () => {
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
    // Lines are physical lines. CRLF counts as one newline and is returned as in the source.
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

    // An empty document is treated as one empty line.
    const blank = (await read(empty, '--lines', '1:1')).data;
    expect(blank.content).toBe('');
    expect((await t.run(['read', empty, '--lines', '2:2', '--json'])).exitCode).toBe(2);
    // No extra line is counted after the trailing newline.
    t.write('trailing.md', 'a\nb\n');
    const trailing = (await t.run(['open', 'trailing.md', '--json'])).json<{
      documents: Array<{ documentId: string }>;
    }>().data.documents[0]?.documentId as string;
    expect((await read(trailing, '--lines', '2:2')).data.content).toBe('b\n');
    expect((await t.run(['read', trailing, '--lines', '3:3', '--json'])).exitCode).toBe(2);
  });
});

describe('SRCH-013 HTML extraction', () => {
  it('script contents, input values, and script-generated text appear neither in search nor in section reads', async () => {
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
    // Indicates the result was extracted statically.
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
    // The source is available separately.
    expect((await read(documentId)).data.content).toContain('SCRIPT-SECRET-VALUE');
  });
});

describe('SRCH-015 / DOC-012 unsearchable documents', () => {
  it('does not claim all documents were searched when one cannot be parsed', async () => {
    t.write('deep.md', `${'> '.repeat(70)}深すぎる引用。認証。\n`);
    const deep = (await t.run(['open', 'deep.md', '--json'])).json<{
      documents: Array<{ documentId: string; searchState: string }>;
    }>().data.documents[0]?.documentId as string;
    const found = (await search('認証', '--limit', '10')).data;
    expect(found.incomplete).toBe(true);
    expect(found.failedDocuments).toEqual([{ documentId: deep, code: 'E_PARSE_FAILED' }]);
    expect(found.registeredDocuments).toBe(5);
    expect(found.searchedDocuments).toBe(4);
    // Results from searchable documents are still returned.
    expect(new Set(paths(found))).toEqual(new Set(['auth.md', 'design-notes.md']));
    const listed = (await t.run(['list', '--json'])).json<{
      documents: Array<{ documentId: string; searchState: string }>;
    }>().data.documents;
    expect(listed.find((entry) => entry.documentId === deep)?.searchState).toBe('excluded');
    expect(listed.filter((entry) => entry.searchState === 'ready')).toHaveLength(4);
  });

  it('does not return the old content of a document that became unreadable as a current search result', async () => {
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

    // The same for a document that lost read permission.
    chmodSync(join(t.work, 'design-notes.md'), 0o000);
    await t.run(['refresh', '--json']);
    const unreadable = (await search('Bearer')).data;
    expect(unreadable.hits).toEqual([]);
    expect(unreadable.failedDocuments.map((entry) => entry.code).toSorted()).toEqual([
      'source-missing',
      'source-unreadable',
    ]);
    chmodSync(join(t.work, 'design-notes.md'), 0o644);

    // Once restored, it is searchable again.
    cpSync(join(fixtures, 'auth.md'), join(t.work, 'auth.md'));
    await t.run(['refresh', '--json']);
    const back = (await search('refresh_token')).data;
    expect(paths(back)).toEqual(['auth.md']);
    expect(back.incomplete).toBe(false);
  });
});
