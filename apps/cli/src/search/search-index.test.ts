import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeDocument } from '@vde-open/document';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  batchesOf,
  PART_LENGTH,
  partsOf,
  partWeight,
  SearchIndex,
  splitParts,
  type IndexedDocument,
} from './search-index.ts';

const fixtures = fileURLToPath(new URL('../../../../tests/fixtures/search', import.meta.url));

function document(order: number, path: string, source?: string): IndexedDocument {
  const text = source ?? readFileSync(join(fixtures, path), 'utf8');
  const format = path.endsWith('.html') ? 'html' : 'markdown';
  const analysis = analyzeDocument(text, format);
  return {
    documentId: `doc_${String(order).padStart(8, '0')}-0000-4000-8000-000000000000`,
    revision: `rev_${String(order).padStart(64, '0')}`,
    format,
    title: analysis.title ?? basename(path),
    displayPath: path,
    fileName: basename(path),
    canonicalPath: `/work/${path}`,
    order,
    sections: analysis.sections,
  };
}

let index: SearchIndex;
const docs = {
  auth: document(0, 'auth.md'),
  notes: document(1, 'design-notes.md'),
  users: document(2, 'api/users.md'),
  runbook: document(3, 'ops/runbook.md'),
};

beforeEach(() => {
  index = new SearchIndex();
  for (const entry of Object.values(docs)) index.upsert(entry);
});

const search = (query: string, mode: 'text' | 'exact' | 'path' = 'text') =>
  index.search({ query, mode, documents: null });
const where = (hits: ReturnType<typeof search>) =>
  hits.map((hit) => `${hit.displayPath ?? ''}#${hit.sectionId}:${hit.matchKind}`);

describe('SRCH-003 Japanese and ASCII search', () => {
  it('Japanese terms without spaces rank the matching documents at the top', () => {
    // Sections with the term in the heading and title rank above sections with it only in the body.
    expect(where(search('認証'))).toEqual([
      'auth.md#sec_0001:phrase',
      'auth.md#sec_0003:phrase',
      'design-notes.md#sec_0002:phrase',
    ]);
    const expiry = search('有効期限');
    expect(expiry[0]).toMatchObject({ displayPath: 'auth.md', sectionId: 'sec_0002' });
    expect(expiry.map((hit) => hit.displayPath)).toContain('ops/runbook.md');
    // Finds sections containing all terms even when they are far apart.
    expect(where(search('セッション 延長'))).toEqual(['auth.md#sec_0002:text']);
  });

  it('finds ASCII identifiers and paths both whole and in part', () => {
    expect(where(search('refresh_token'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('REFRESH_TOKEN'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('pageSize'))).toEqual(['api/users.md#sec_0002:phrase']);
    // A part of an identifier is found too.
    expect(where(search('refresh'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('token refresh'))).toEqual(['auth.md#sec_0002:text']);
    expect(where(search('/api/v2/users')).map((entry) => entry.split('#')[0])).toEqual([
      'api/users.md',
      'api/users.md',
    ]);
    expect(search('USER_NOT_FOUND')[0]).toMatchObject({ sectionId: 'sec_0003' });
    // The same when written in full-width.
    expect(where(search('ＡＵＴＨ＿ＬＯＣＫＥＤ'))).toEqual(['auth.md#sec_0003:phrase']);
  });

  it('returns nothing if a term does not match; terms are not dropped to form another search', () => {
    expect(search('認証 存在しない語xyz')).toEqual([]);
    expect(search('量子計算')).toEqual([]);
  });

  it('prefix and fuzzy matches are secondary and rank below exact matches', () => {
    // A truncated word is not treated as a literal match.
    expect(where(search('toke')).toSorted()).toEqual([
      'auth.md#sec_0002:prefix',
      'design-notes.md#sec_0002:prefix',
    ]);
    // A section with an exact match ranks above prefix matches.
    index.upsert(document(8, 'toke.md', '# 別件\n\ntoke という語そのもの。\n'));
    expect(where(search('toke'))[0]).toBe('toke.md#sec_0001:phrase');
    index.remove(document(8, 'toke.md', '').documentId);
    // Only ASCII terms of 4 or more characters allow a one-character spelling variation.
    expect(search('tokem').map((hit) => hit.matchKind)).toEqual(['fuzzy', 'fuzzy']);
    expect(search('apj')).toEqual([]);
    // Not applied to Japanese.
    expect(search('認正')).toEqual([]);
    // A partial Japanese word is found as a literal match (not a term prefix match).
    expect(search('認').every((hit) => hit.matchKind === 'phrase')).toBe(true);
  });
});

describe('SRCH-004 search modes', () => {
  it('exact matches only literal strings, and path only file names and paths', () => {
    // text matches even when the terms are apart. exact does not.
    expect(where(search('有効期限 セッション'))).toEqual(['auth.md#sec_0002:text']);
    expect(search('有効期限 セッション', 'exact')).toEqual([]);
    expect(where(search('セッションの有効期限', 'exact'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('30分で失効', 'exact'))).toEqual(['auth.md#sec_0002:phrase']);

    // path does not look at the body.
    expect(search('認証', 'path')).toEqual([]);
    expect(where(search('users', 'path'))).toEqual(['api/users.md#sec_0001:phrase']);
    expect(where(search('ops/', 'path'))).toEqual(['ops/runbook.md#sec_0001:phrase']);
    expect(where(search('runbook.md', 'path'))).toEqual(['ops/runbook.md#sec_0001:path-exact']);
  });

  it('treats the query as literal text, not as a regular expression', () => {
    // Queries that would match as regular expressions do not match.
    for (const mode of ['text', 'exact', 'path'] as const) {
      for (const query of ['.*', '認.仕様', '[a-z]+', '^#', 'auth\\.md|users', '認+', 'a{4}']) {
        expect(search(query, mode), `${mode}: ${query}`).toEqual([]);
      }
    }
    // Symbols are separators. `|` is not "or"; only sections with both terms match.
    expect(where(search('(認証|設計)'))).toEqual(['design-notes.md#sec_0002:text']);
    // A string containing symbols can be found as a literal match.
    expect(where(search('{userId}', 'exact'))).toEqual(['api/users.md#sec_0003:phrase']);
  });
});

describe('SRCH-005 ranking', () => {
  it('orders exact file name or path matches, literal matches, then term matches; ties follow list order and section order', () => {
    index.upsert(
      document(4, 'auth.md.bak.md', '# 予備\n\n「auth.md」という名前に触れているだけの文書。\n'),
    );
    const hits = where(search('auth.md'));
    expect(hits[0]).toBe('auth.md#sec_0001:path-exact');
    expect(hits).toContain('auth.md.bak.md#sec_0001:phrase');

    // A section where the terms appear together ranks above one where they are scattered.
    index.upsert(
      document(
        5,
        'scattered.md',
        '# 別件\n\n期限の話。有効な設定は別の節にある。セッションは関係する。\n',
      ),
    );
    const phrase = where(search('セッションの有効期限'));
    expect(phrase[0]).toBe('auth.md#sec_0002:phrase');

    // Identical documents follow the list order. Results are the same every time.
    const first = document(6, 'copy-a.md', '# 同じ\n\n固有の語キーワードZ。\n');
    const second = document(7, 'copy-b.md', '# 同じ\n\n固有の語キーワードZ。\n');
    index.upsert(second);
    index.upsert(first);
    expect(where(search('キーワードZ'))).toEqual([
      'copy-a.md#sec_0001:phrase',
      'copy-b.md#sec_0001:phrase',
    ]);
    expect(search('キーワードZ')).toEqual(search('キーワードZ'));
  });

  it('weights title, heading, path, then body', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'a/body.md', '# 無関係\n\n本文にだけターゲット語がある。\n'));
    fresh.upsert(document(1, 'a/heading.md', '# 無関係\n\n## ターゲット語\n\n本文。\n'));
    fresh.upsert(document(2, 'a/title.md', '# ターゲット語\n\n本文。\n'));
    const hits = fresh.search({ query: 'ターゲット語', mode: 'text', documents: null });
    expect(hits.map((hit) => hit.displayPath)).toEqual(['a/title.md', 'a/heading.md', 'a/body.md']);
    expect(hits[0]?.score).toBeGreaterThan(hits[2]?.score ?? 0);
  });
});

describe('SRCH-006 number of hits per document', () => {
  it('returns at most 2 hits from one large document, leaving room for other documents', () => {
    const big = Array.from(
      { length: 200 },
      (_, n) => `## 節${String(n)}\n\n認証について、${String(n)}番目の説明。\n`,
    ).join('\n');
    index.upsert(document(9, 'big.md', `# 巨大な文書\n\n${big}`));
    const hits = search('認証');
    const counts = new Map<string, number>();
    for (const hit of hits) {
      counts.set(hit.displayPath ?? '', (counts.get(hit.displayPath ?? '') ?? 0) + 1);
    }
    expect(counts.get('big.md')).toBe(2);
    expect([...counts.values()].every((count) => count <= 2)).toBe(true);
    expect(counts.has('auth.md')).toBe(true);
    expect(counts.has('design-notes.md')).toBe(true);
  });
});

describe('SRCH-016 excerpts', () => {
  it('an excerpt is an actual slice of the extracted body, up to 240 characters', () => {
    const hit = search('refresh_token')[0];
    expect(hit?.excerpt).toContain('refresh_token');
    const section = docs.auth.sections.find((entry) => entry.sectionId === hit?.sectionId);
    // Only whitespace is collapsed; no characters absent from the body are added.
    expect(section?.text.replace(/\s+/g, ' ')).toContain(hit?.excerpt ?? 'x');

    const long = `# 長い節\n\n${'あ'.repeat(1000)}目印の語${'い'.repeat(1000)}\n`;
    index.upsert(document(10, 'long.md', long));
    const found = search('目印の語')[0];
    expect(found?.excerpt).toContain('目印の語');
    expect(Array.from(found?.excerpt ?? '').length).toBeLessThanOrEqual(240);
    // Never cuts inside an emoji or other multi-unit character.
    index.upsert(document(11, 'emoji.md', `# 絵文字\n\n${'😀'.repeat(400)}末尾の語\n`));
    const emoji = search('末尾の語')[0]?.excerpt ?? '';
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    expect(hit?.sourceRange).toBeNull();
  });
});

describe('SRCH-001 / SRCH-002 target documents', () => {
  it('removed documents and replaced revisions do not appear in results', () => {
    index.remove(docs.auth.documentId);
    expect(search('refresh_token')).toEqual([]);
    expect(search('認証').map((hit) => hit.displayPath)).not.toContain('auth.md');

    // After replacing the revision, the previous content is not found.
    const updated = { ...document(1, 'design-notes.md', '# 設計メモ\n\n方式は決まった。\n') };
    index.upsert({ ...updated, revision: `rev_${'9'.repeat(64)}` });
    expect(search('Bearer')).toEqual([]);
    expect(search('決まった')[0]?.revision).toBe(`rev_${'9'.repeat(64)}`);
    expect(index.revisionOf(updated.documentId)).toBe(`rev_${'9'.repeat(64)}`);

    // Restricting the target documents excludes the others.
    const only = index.search({
      query: '有効期限',
      mode: 'text',
      documents: new Set([docs.runbook.documentId]),
    });
    expect(only.map((hit) => hit.displayPath)).toEqual(['ops/runbook.md']);
  });
});

describe('SRCH-003 / SRCH-004 secondary matches and verbatim strings', () => {
  it('spelling variation allows at most one character difference regardless of term length', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'long.md', '# 見出し\n\nabcdefghijklmnop という語。\n'));
    expect(fresh.search({ query: 'abcdefghijklmnox', mode: 'text', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'fuzzy' }),
    ]);
    // Two differences do not match even for a long term.
    expect(fresh.search({ query: 'abcdefghijklmnxx', mode: 'text', documents: null })).toEqual([]);
  });

  it('a single ASCII character is not treated as a prefix match inside words', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'foo.md', '# 見出し\n\nfoo bar\n'));
    expect(fresh.search({ query: 'o', mode: 'text', documents: null })).toEqual([]);
    expect(fresh.search({ query: 'fo', mode: 'text', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'prefix' }),
    ]);
  });

  it('exact and path match the verbatim string, whitespace included', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'a  b.md', '# 見出し\n\n```\nfoo\tbar\n```\n'));
    expect(fresh.search({ query: 'a  b.md', mode: 'path', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'path-exact' }),
    ]);
    expect(fresh.search({ query: 'foo\tbar', mode: 'exact', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'phrase' }),
    ]);
    // A different amount of whitespace does not match in exact.
    expect(fresh.search({ query: 'foo bar', mode: 'exact', documents: null })).toEqual([]);
    // text ignores whitespace differences.
    expect(fresh.search({ query: 'foo bar', mode: 'text', documents: null })).toHaveLength(1);
  });
});

describe('SRCH-002 replacing documents in the index', () => {
  it('a revision being added is not searchable and replaces the previous one on commit', () => {
    const fresh = new SearchIndex();
    const first = document(0, 'a.md', '# 見出し\n\n古い語。\n');
    fresh.upsert(first);
    const { sections, ...meta } = document(0, 'a.md', '# 見出し\n\n新しい語。\n');
    const next = { ...meta, revision: `rev_${'1'.repeat(64)}` };
    fresh.begin(next);
    fresh.append(next.documentId, next.revision, partsOf(sections));
    const query = (text: string) => fresh.search({ query: text, mode: 'text', documents: null });
    expect(query('新しい語')).toEqual([]);
    expect(query('古い語')).toEqual([expect.objectContaining({ revision: first.revision })]);
    fresh.commit(next.documentId, next.revision);
    expect(query('古い語')).toEqual([]);
    expect(query('新しい語')).toEqual([expect.objectContaining({ revision: next.revision })]);
    // An aborted revision cannot be committed.
    fresh.begin({ ...next, revision: `rev_${'2'.repeat(64)}` });
    fresh.abort(next.documentId);
    expect(() => fresh.commit(next.documentId, `rev_${'2'.repeat(64)}`)).toThrow();
    expect(query('新しい語')).toHaveLength(1);
  });

  it('title-only and path-only changes apply to search and hits without re-indexing the content', () => {
    const fresh = new SearchIndex();
    const before = { ...document(0, 'a.md', '# 見出し\n\n本文。\n'), title: 'OldBeacon' };
    fresh.upsert(before);
    const { sections: _sections, ...meta } = before;
    expect(fresh.updateMeta({ ...meta, title: 'NewBeacon', displayPath: 'moved/a.md' })).toBe(true);
    const query = (text: string, mode: 'text' | 'path' = 'text') =>
      fresh.search({ query: text, mode, documents: null });
    expect(query('OldBeacon')).toEqual([]);
    expect(query('NewBeacon')).toEqual([
      expect.objectContaining({ title: 'NewBeacon', displayPath: 'moved/a.md' }),
    ]);
    expect(query('moved', 'path')).toHaveLength(1);
    // With a different revision, attributes alone cannot be changed (re-indexing is needed).
    expect(fresh.updateMeta({ ...meta, revision: `rev_${'9'.repeat(64)}` })).toBe(false);
  });

  it('long sections are split, strings across the split boundary are found, and returned as one section', () => {
    const filler = 'あ'.repeat(PART_LENGTH - 5);
    const text = `# 長い節\n\n${filler}境目をまたぐ語${'い'.repeat(PART_LENGTH * 2)}末尾の語\n`;
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'long.md', text));
    const sections = analyzeDocument(text, 'markdown').sections;
    expect(partsOf(sections).length).toBeGreaterThan(2);
    for (const query of ['境目をまたぐ語', '末尾の語']) {
      expect(fresh.search({ query, mode: 'exact', documents: null })).toEqual([
        expect.objectContaining({ sectionId: 'sec_0001', matchKind: 'phrase' }),
      ]);
    }
    expect(fresh.search({ query: 'あ', mode: 'text', documents: null })).toHaveLength(1);
  });

  it('parts have a fixed length except the last, and never cut inside a character', () => {
    const text = `${'😀'.repeat(PART_LENGTH)}`;
    const parts = splitParts(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(PART_LENGTH);
      expect(part.codePointAt(0)).toBe('😀'.codePointAt(0));
      expect(Array.from(part).every((char) => char === '😀')).toBe(true);
    }
  });
});

describe('SRCH-003 split sections', () => {
  it('finds term combinations in distant parts of the same section', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'far.md', `# 遠い語\n\nalpha ${'filler '.repeat(5000)} omega\n`));
    const query = (text: string) => fresh.search({ query: text, mode: 'text', documents: null });
    expect(query('alpha')).toHaveLength(1);
    expect(query('omega')).toHaveLength(1);
    expect(query('alpha omega')).toEqual([
      expect.objectContaining({ sectionId: 'sec_0001', matchKind: 'text' }),
    ]);
    // A heading term combined with a body term in a distant part.
    expect(query('遠い omega')).toHaveLength(1);
    // Terms in different sections do not match together.
    fresh.upsert(document(1, 'split.md', '# 前\n\nalpha\n\n# 後\n\nomega\n'));
    expect(query('alpha omega').map((hit) => hit.displayPath)).toEqual(['far.md']);
  });

  it('long headings are split too, and hits return the full original heading', () => {
    const heading = `${'見'.repeat(PART_LENGTH - 3)}境目の語${'出'.repeat(PART_LENGTH)}`;
    const source = `# ${heading}\n\n## 子\n\n本文。\n`;
    const parts = partsOf(analyzeDocument(source, 'markdown').sections);
    // The heading section has as many parts as the heading was split into. The section shape is only on the first part.
    const own = parts.filter((part) => part.sectionIndex === 0);
    expect(own.length).toBeGreaterThan(1);
    expect(own.filter((part) => part.section !== null)).toHaveLength(1);
    // The child section holds only the parent section index, not a copy of the ancestor heading.
    expect(parts.find((part) => part.sectionIndex === 1)?.section?.parent).toBe(0);
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'heading.md', source));
    const [hit] = fresh.search({ query: '境目の語', mode: 'exact', documents: null });
    expect(hit).toMatchObject({ sectionId: 'sec_0001' });
    expect(hit?.headingPath).toEqual([heading]);
    const [child] = fresh.search({ query: '本文', mode: 'exact', documents: null });
    expect(child?.headingPath).toEqual([heading, '子']);
  });

  it('finds the combination of the nearest ancestor heading term and a body term even with a long top heading', () => {
    const source = `# ${'長'.repeat(5000)}\n\n## Authorization\n\n### 期限\n\nexpiry の説明。\n`;
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'context.md', source));
    const hits = fresh.search({ query: 'Authorization expiry', mode: 'text', documents: null });
    expect(hits).toEqual([expect.objectContaining({ sectionId: 'sec_0003' })]);
    expect(hits[0]?.headingPath.slice(1)).toEqual(['Authorization', '期限']);
    // Descendant sections are found by an ancestor heading term alone. The heading's own section ranks first.
    expect(
      fresh
        .search({ query: 'Authorization', mode: 'text', documents: null })
        .map((hit) => hit.sectionId),
    ).toEqual(['sec_0002', 'sec_0003']);
  });

  it('the excerpt of a section matched across heading and body is taken from the body match position', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'far.md', `# Alpha\n\n${'filler '.repeat(5000)} omega\n`));
    const [hit] = fresh.search({ query: 'alpha omega', mode: 'text', documents: null });
    expect(hit?.excerpt).toContain('omega');
  });

  it('batches are cut before exceeding the limit; only single-part batches may exceed it', () => {
    const heading = '見'.repeat(100_000);
    const children = Array.from({ length: 50 }, (_, at) => `## 子${String(at)}\n\n本文。\n`);
    const sections = analyzeDocument(`# ${heading}\n\n${children.join('\n')}`, 'markdown').sections;
    const parts = partsOf(sections);
    // Count the indexed amount (heading and body length) independently of the implementation.
    const indexed = (part: (typeof parts)[number]) => part.heading.length + part.body.length;
    for (const part of parts) {
      expect(partWeight(part)).toBe(indexed(part));
      expect(indexed(part)).toBeLessThanOrEqual(PART_LENGTH * 2);
    }
    const batches = batchesOf(parts, 65_536, 256);
    expect(batches.flat()).toEqual(parts);
    // Only a single-part batch may exceed the limit.
    const overweight = batches.filter(
      (batch) => batch.reduce((total, part) => total + indexed(part), 0) > 65_536,
    );
    expect(overweight.every((batch) => batch.length === 1)).toBe(true);
    expect(batches.every((batch) => batch.length <= 256)).toBe(true);
    // The sent value does not include the full ancestor heading (only the parent section index).
    const sent = JSON.stringify(parts);
    expect(sent.length).toBeLessThan(heading.length * 1.5);
  });
});

describe('SRCH-005 / SRCH-016 match kinds, excerpts, and ancestor heading scores', () => {
  it('even when a literal heading match raises the kind, the excerpt is taken from the body match', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'far.md', `# Alpha\n\n${'filler '.repeat(5000)} alpha\n`));
    const [hit] = fresh.search({ query: 'alpha', mode: 'text', documents: null });
    expect(hit?.matchKind).toBe('phrase');
    expect(hit?.excerpt).toContain('alpha');
  });

  it('only the heading score is inherited by descendants; document title matches are not mixed in', () => {
    const source = '## Authorization\n\n概要。\n\n### 期限\n\nexpiry の説明。\n';
    const fresh = new SearchIndex();
    const first = { ...document(0, 'a.md', source), title: 'Notes' };
    const second = { ...document(1, 'b.md', source), title: 'Authorization' };
    fresh.upsert(first);
    fresh.upsert(second);
    const hits = fresh.search({ query: 'authorization expiry', mode: 'text', documents: null });
    // Sections with the same heading and body have the same score and follow the list order. The title does not reorder them.
    expect(hits.map((hit) => [hit.documentId, hit.sectionId])).toEqual([
      [first.documentId, 'sec_0002'],
      [second.documentId, 'sec_0002'],
    ]);
    expect(hits[0]?.score).toBe(hits[1]?.score);
  });
});

describe('PERF-003 entries retained by the index', () => {
  it('after repeated re-indexing and removal, entry and term counts return to those of the remaining documents', async () => {
    const before = await index.retainedCounts(true);
    for (let round = 0; round < 30; round += 1) {
      const changed = document(
        9,
        'extra.md',
        `# 追加${String(round)}\n\n語${String(round)}を含む本文。\n`,
      );
      index.upsert(changed);
      index.remove(changed.documentId);
      // A document aborted while being added does not remain either.
      index.begin(changed);
      index.abort(changed.documentId);
    }
    const after = await index.retainedCounts(true);
    expect(after).toEqual(before);
    expect(after.staging).toBe(0);
    expect(after.miniDirt).toBe(0);
  });
});
