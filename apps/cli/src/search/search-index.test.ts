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

describe('SRCH-003 日本語と英数の検索', () => {
  it('空白のない日本語の語で、対応する文書が上位に入る', () => {
    // 見出しとtitleに語がある節が、本文にだけ語がある節より上。
    expect(where(search('認証'))).toEqual([
      'auth.md#sec_0001:phrase',
      'auth.md#sec_0003:phrase',
      'design-notes.md#sec_0002:phrase',
    ]);
    const expiry = search('有効期限');
    expect(expiry[0]).toMatchObject({ displayPath: 'auth.md', sectionId: 'sec_0002' });
    expect(expiry.map((hit) => hit.displayPath)).toContain('ops/runbook.md');
    // 語が離れていても、全部の語を含む節を見つける。
    expect(where(search('セッション 延長'))).toEqual(['auth.md#sec_0002:text']);
  });

  it('英数のidentifierとpathを、そのままの形でも、部分でも見つける', () => {
    expect(where(search('refresh_token'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('REFRESH_TOKEN'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('pageSize'))).toEqual(['api/users.md#sec_0002:phrase']);
    // identifierの一部でも見つかる。
    expect(where(search('refresh'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('token refresh'))).toEqual(['auth.md#sec_0002:text']);
    expect(where(search('/api/v2/users')).map((entry) => entry.split('#')[0])).toEqual([
      'api/users.md',
      'api/users.md',
    ]);
    expect(search('USER_NOT_FOUND')[0]).toMatchObject({ sectionId: 'sec_0003' });
    // 全角で書いても同じ。
    expect(where(search('ＡＵＴＨ＿ＬＯＣＫＥＤ'))).toEqual(['auth.md#sec_0003:phrase']);
  });

  it('一致する語がなければ0件。語を減らして別の検索へ変えない', () => {
    expect(search('認証 存在しない語xyz')).toEqual([]);
    expect(search('量子計算')).toEqual([]);
  });

  it('前方一致と綴りのゆらぎは、補助として、完全な一致より下に置く', () => {
    // 語の途中までの文字列は、連続した一致としては扱わない。
    expect(where(search('toke')).toSorted()).toEqual([
      'auth.md#sec_0002:prefix',
      'design-notes.md#sec_0002:prefix',
    ]);
    // 完全に一致する節があれば、それが前方一致より上に来る。
    index.upsert(document(8, 'toke.md', '# 別件\n\ntoke という語そのもの。\n'));
    expect(where(search('toke'))[0]).toBe('toke.md#sec_0001:phrase');
    index.remove(document(8, 'toke.md', '').documentId);
    // 英数の4文字以上の語だけ、1文字までの綴りのゆらぎを許す。
    expect(search('tokem').map((hit) => hit.matchKind)).toEqual(['fuzzy', 'fuzzy']);
    expect(search('apj')).toEqual([]);
    // 日本語には適用しない。
    expect(search('認正')).toEqual([]);
    // 語の一部だけの日本語は、連続した文字列の一致として見つかる（語の前方一致ではない）。
    expect(search('認').every((hit) => hit.matchKind === 'phrase')).toBe(true);
  });
});

describe('SRCH-004 検索の種類', () => {
  it('exactは連続した文字列だけ、pathはfile名とpathだけを対象にする', () => {
    // textでは、語が離れていても一致する。exactでは一致しない。
    expect(where(search('有効期限 セッション'))).toEqual(['auth.md#sec_0002:text']);
    expect(search('有効期限 セッション', 'exact')).toEqual([]);
    expect(where(search('セッションの有効期限', 'exact'))).toEqual(['auth.md#sec_0002:phrase']);
    expect(where(search('30分で失効', 'exact'))).toEqual(['auth.md#sec_0002:phrase']);

    // pathは本文を見ない。
    expect(search('認証', 'path')).toEqual([]);
    expect(where(search('users', 'path'))).toEqual(['api/users.md#sec_0001:phrase']);
    expect(where(search('ops/', 'path'))).toEqual(['ops/runbook.md#sec_0001:phrase']);
    expect(where(search('runbook.md', 'path'))).toEqual(['ops/runbook.md#sec_0001:path-exact']);
  });

  it('queryは文字として扱い、正規表現としては実行しない', () => {
    // 正規表現として実行すれば一致するqueryが、一致しない。
    for (const mode of ['text', 'exact', 'path'] as const) {
      for (const query of ['.*', '認.仕様', '[a-z]+', '^#', 'auth\\.md|users', '認+', 'a{4}']) {
        expect(search(query, mode), `${mode}: ${query}`).toEqual([]);
      }
    }
    // 記号は区切りとして扱う。`|`は「または」ではなく、両方の語を含む節だけが一致する。
    expect(where(search('(認証|設計)'))).toEqual(['design-notes.md#sec_0002:text']);
    // 記号を含む文字列そのものは、連続した一致で探せる。
    expect(where(search('{userId}', 'exact'))).toEqual(['api/users.md#sec_0003:phrase']);
  });
});

describe('SRCH-005 順位', () => {
  it('file名・pathの完全一致、連続した一致、語の一致の順に並べ、同じ順位は登録順と節の順', () => {
    index.upsert(
      document(4, 'auth.md.bak.md', '# 予備\n\n「auth.md」という名前に触れているだけの文書。\n'),
    );
    const hits = where(search('auth.md'));
    expect(hits[0]).toBe('auth.md#sec_0001:path-exact');
    expect(hits).toContain('auth.md.bak.md#sec_0001:phrase');

    // 語が並んだまま現れる節が、語がばらばらに現れる節より上。
    index.upsert(
      document(
        5,
        'scattered.md',
        '# 別件\n\n期限の話。有効な設定は別の節にある。セッションは関係する。\n',
      ),
    );
    const phrase = where(search('セッションの有効期限'));
    expect(phrase[0]).toBe('auth.md#sec_0002:phrase');

    // 同じ内容の文書は、一覧での順番で並ぶ。結果は毎回同じ。
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

  it('title・見出し・path・本文の順に重みを付ける', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'a/body.md', '# 無関係\n\n本文にだけターゲット語がある。\n'));
    fresh.upsert(document(1, 'a/heading.md', '# 無関係\n\n## ターゲット語\n\n本文。\n'));
    fresh.upsert(document(2, 'a/title.md', '# ターゲット語\n\n本文。\n'));
    const hits = fresh.search({ query: 'ターゲット語', mode: 'text', documents: null });
    expect(hits.map((hit) => hit.displayPath)).toEqual(['a/title.md', 'a/heading.md', 'a/body.md']);
    expect(hits[0]?.score).toBeGreaterThan(hits[2]?.score ?? 0);
  });
});

describe('SRCH-006 1文書からのhitの数', () => {
  it('1つの大きい文書に多数のhitがあっても、返すのは2件まで。ほかの文書の候補が残る', () => {
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

describe('SRCH-016 抜粋', () => {
  it('抜粋は、抽出した本文の実際の一部で、240文字まで', () => {
    const hit = search('refresh_token')[0];
    expect(hit?.excerpt).toContain('refresh_token');
    const section = docs.auth.sections.find((entry) => entry.sectionId === hit?.sectionId);
    // 空白をまとめただけで、本文にない文字は足していない。
    expect(section?.text.replace(/\s+/g, ' ')).toContain(hit?.excerpt ?? 'x');

    const long = `# 長い節\n\n${'あ'.repeat(1000)}目印の語${'い'.repeat(1000)}\n`;
    index.upsert(document(10, 'long.md', long));
    const found = search('目印の語')[0];
    expect(found?.excerpt).toContain('目印の語');
    expect(Array.from(found?.excerpt ?? '').length).toBeLessThanOrEqual(240);
    // 絵文字などの途中で切らない。
    index.upsert(document(11, 'emoji.md', `# 絵文字\n\n${'😀'.repeat(400)}末尾の語\n`));
    const emoji = search('末尾の語')[0]?.excerpt ?? '';
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    expect(hit?.sourceRange).toBeNull();
  });
});

describe('SRCH-001 / SRCH-002 対象の文書', () => {
  it('indexから外した文書と、置き換える前の版は、結果に出ない', () => {
    index.remove(docs.auth.documentId);
    expect(search('refresh_token')).toEqual([]);
    expect(search('認証').map((hit) => hit.displayPath)).not.toContain('auth.md');

    // 版を置き換えると、前の版の内容では見つからない。
    const updated = { ...document(1, 'design-notes.md', '# 設計メモ\n\n方式は決まった。\n') };
    index.upsert({ ...updated, revision: `rev_${'9'.repeat(64)}` });
    expect(search('Bearer')).toEqual([]);
    expect(search('決まった')[0]?.revision).toBe(`rev_${'9'.repeat(64)}`);
    expect(index.revisionOf(updated.documentId)).toBe(`rev_${'9'.repeat(64)}`);

    // 対象の文書を絞ると、ほかの文書は出ない。
    const only = index.search({
      query: '有効期限',
      mode: 'text',
      documents: new Set([docs.runbook.documentId]),
    });
    expect(only.map((hit) => hit.displayPath)).toEqual(['ops/runbook.md']);
  });
});

describe('SRCH-003 / SRCH-004 補助の一致と、指定どおりの文字列', () => {
  it('綴りのゆらぎは、語の長さによらず1文字の違いまで', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'long.md', '# 見出し\n\nabcdefghijklmnop という語。\n'));
    expect(fresh.search({ query: 'abcdefghijklmnox', mode: 'text', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'fuzzy' }),
    ]);
    // 2文字違えば、長い語でも一致しない。
    expect(fresh.search({ query: 'abcdefghijklmnxx', mode: 'text', documents: null })).toEqual([]);
  });

  it('1文字の英数は、語の途中への前方一致として扱わない', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'foo.md', '# 見出し\n\nfoo bar\n'));
    expect(fresh.search({ query: 'o', mode: 'text', documents: null })).toEqual([]);
    expect(fresh.search({ query: 'fo', mode: 'text', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'prefix' }),
    ]);
  });

  it('exactとpathは、空白を含めて指定どおりの文字列で照合する', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'a  b.md', '# 見出し\n\n```\nfoo\tbar\n```\n'));
    expect(fresh.search({ query: 'a  b.md', mode: 'path', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'path-exact' }),
    ]);
    expect(fresh.search({ query: 'foo\tbar', mode: 'exact', documents: null })).toEqual([
      expect.objectContaining({ matchKind: 'phrase' }),
    ]);
    // 空白の数が違えば、exactでは一致しない。
    expect(fresh.search({ query: 'foo bar', mode: 'exact', documents: null })).toEqual([]);
    // textでは、空白の違いを問わない。
    expect(fresh.search({ query: 'foo bar', mode: 'text', documents: null })).toHaveLength(1);
  });
});

describe('SRCH-002 indexへの入れ替え', () => {
  it('入れている途中の版は検索に出さず、確定した時点で前の版と入れ替える', () => {
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
    // 途中で捨てた版は、確定しない。
    fresh.begin({ ...next, revision: `rev_${'2'.repeat(64)}` });
    fresh.abort(next.documentId);
    expect(() => fresh.commit(next.documentId, `rev_${'2'.repeat(64)}`)).toThrow();
    expect(query('新しい語')).toHaveLength(1);
  });

  it('titleとpathだけの変更は、本文を入れ直さずに検索とhitへ反映する', () => {
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
    // 版が違えば、属性だけの変更はできない（入れ直しが必要）。
    expect(fresh.updateMeta({ ...meta, revision: `rev_${'9'.repeat(64)}` })).toBe(false);
  });

  it('長い節は分けて入れ、分けた境目をまたぐ文字列も見つけ、1つの節として返す', () => {
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

  it('分けた部分は、最後の部分を除いて決まった長さで、文字の途中で切らない', () => {
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

describe('SRCH-003 分けて入れた節', () => {
  it('同じ節の、離れた部分にある語の組み合わせでも見つける', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'far.md', `# 遠い語\n\nalpha ${'filler '.repeat(5000)} omega\n`));
    const query = (text: string) => fresh.search({ query: text, mode: 'text', documents: null });
    expect(query('alpha')).toHaveLength(1);
    expect(query('omega')).toHaveLength(1);
    expect(query('alpha omega')).toEqual([
      expect.objectContaining({ sectionId: 'sec_0001', matchKind: 'text' }),
    ]);
    // 見出しの語と、離れた部分の本文の語の組み合わせ。
    expect(query('遠い omega')).toHaveLength(1);
    // 別の節にある語の組み合わせは、一致しない。
    fresh.upsert(document(1, 'split.md', '# 前\n\nalpha\n\n# 後\n\nomega\n'));
    expect(query('alpha omega').map((hit) => hit.displayPath)).toEqual(['far.md']);
  });

  it('長い見出しも分けて入れ、hitでは元の見出しの全文を返す', () => {
    const heading = `${'見'.repeat(PART_LENGTH - 3)}境目の語${'出'.repeat(PART_LENGTH)}`;
    const source = `# ${heading}\n\n## 子\n\n本文。\n`;
    const parts = partsOf(analyzeDocument(source, 'markdown').sections);
    // 見出しの節は、見出しを分けた数だけの部分を持つ。節の形は先頭の部分にだけ入る。
    const own = parts.filter((part) => part.sectionIndex === 0);
    expect(own.length).toBeGreaterThan(1);
    expect(own.filter((part) => part.section !== null)).toHaveLength(1);
    // 子の節は、上位の見出しを複製せず、親の節の番号だけを持つ。
    expect(parts.find((part) => part.sectionIndex === 1)?.section?.parent).toBe(0);
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'heading.md', source));
    const [hit] = fresh.search({ query: '境目の語', mode: 'exact', documents: null });
    expect(hit).toMatchObject({ sectionId: 'sec_0001' });
    expect(hit?.headingPath).toEqual([heading]);
    const [child] = fresh.search({ query: '本文', mode: 'exact', documents: null });
    expect(child?.headingPath).toEqual([heading, '子']);
  });

  it('長い上位の見出しがあっても、直近の上位の見出しの語と本文の語の組み合わせで見つける', () => {
    const source = `# ${'長'.repeat(5000)}\n\n## Authorization\n\n### 期限\n\nexpiry の説明。\n`;
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'context.md', source));
    const hits = fresh.search({ query: 'Authorization expiry', mode: 'text', documents: null });
    expect(hits).toEqual([expect.objectContaining({ sectionId: 'sec_0003' })]);
    expect(hits[0]?.headingPath.slice(1)).toEqual(['Authorization', '期限']);
    // 上位の見出しの語だけでも、配下の節は見つかる。見出しそのものの節が上位に来る。
    expect(
      fresh
        .search({ query: 'Authorization', mode: 'text', documents: null })
        .map((hit) => hit.sectionId),
    ).toEqual(['sec_0002', 'sec_0003']);
  });

  it('見出しと本文に分かれて一致した節の抜粋は、本文の一致した位置から取る', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'far.md', `# Alpha\n\n${'filler '.repeat(5000)} omega\n`));
    const [hit] = fresh.search({ query: 'alpha omega', mode: 'text', documents: null });
    expect(hit?.excerpt).toContain('omega');
  });

  it('1回に入れる量は、上限を超える前に区切る。上限を超えるのは1つの部分だけの回', () => {
    const heading = '見'.repeat(100_000);
    const children = Array.from({ length: 50 }, (_, at) => `## 子${String(at)}\n\n本文。\n`);
    const sections = analyzeDocument(`# ${heading}\n\n${children.join('\n')}`, 'markdown').sections;
    const parts = partsOf(sections);
    // 索引に入れる量（見出しと本文の長さ）を、実装とは別に数える。
    const indexed = (part: (typeof parts)[number]) => part.heading.length + part.body.length;
    for (const part of parts) {
      expect(partWeight(part)).toBe(indexed(part));
      expect(indexed(part)).toBeLessThanOrEqual(PART_LENGTH * 2);
    }
    const batches = batchesOf(parts, 65_536, 256);
    expect(batches.flat()).toEqual(parts);
    // 上限を超えてよいのは、1つの部分だけの回。
    const overweight = batches.filter(
      (batch) => batch.reduce((total, part) => total + indexed(part), 0) > 65_536,
    );
    expect(overweight.every((batch) => batch.length === 1)).toBe(true);
    expect(batches.every((batch) => batch.length <= 256)).toBe(true);
    // 送る値に、上位の見出しの全文は含まれない（親の節の番号だけ）。
    const sent = JSON.stringify(parts);
    expect(sent.length).toBeLessThan(heading.length * 1.5);
  });
});

describe('SRCH-005 / SRCH-016 一致の種類と抜粋、上位の見出しのscore', () => {
  it('見出しの連続した一致で種類が上がっても、抜粋は本文の一致した部分から取る', () => {
    const fresh = new SearchIndex();
    fresh.upsert(document(0, 'far.md', `# Alpha\n\n${'filler '.repeat(5000)} alpha\n`));
    const [hit] = fresh.search({ query: 'alpha', mode: 'text', documents: null });
    expect(hit?.matchKind).toBe('phrase');
    expect(hit?.excerpt).toContain('alpha');
  });

  it('配下の節へ引き継ぐのは見出しのscoreだけで、文書のtitleへの一致は混ぜない', () => {
    const source = '## Authorization\n\n概要。\n\n### 期限\n\nexpiry の説明。\n';
    const fresh = new SearchIndex();
    const first = { ...document(0, 'a.md', source), title: 'Notes' };
    const second = { ...document(1, 'b.md', source), title: 'Authorization' };
    fresh.upsert(first);
    fresh.upsert(second);
    const hits = fresh.search({ query: 'authorization expiry', mode: 'text', documents: null });
    // 同じ見出しと本文を持つ節は同じscoreで、一覧の順に並ぶ。titleで順位が入れ替わらない。
    expect(hits.map((hit) => [hit.documentId, hit.sectionId])).toEqual([
      [first.documentId, 'sec_0002'],
      [second.documentId, 'sec_0002'],
    ]);
    expect(hits[0]?.score).toBe(hits[1]?.score);
  });
});
