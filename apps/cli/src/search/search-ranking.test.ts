import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeDocument } from '@vde-open/document';
import type { SearchMode } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import { PART_LENGTH, partsOf, SearchIndex, type IndexedDocument } from './search-index.ts';

// Every hit of a fixed set of queries, with match kind, score, heading path, and excerpt.
// Changes that are meant to keep search results the same (such as performance work) must not change this file.
// When results are meant to change, review the diff of the snapshot.

const fixtures = fileURLToPath(new URL('../../../../tests/fixtures/search', import.meta.url));

function document(order: number, path: string, source: string): IndexedDocument {
  const format = path.endsWith('.html') ? 'html' : 'markdown';
  const analysis = analyzeDocument(source, format);
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

const fixture = (path: string) => readFileSync(join(fixtures, path), 'utf8');

// Filler of a given length that contains none of the query terms.
function filler(length: number): string {
  const words = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', '雑記', 'の', '文章', 'です。'];
  const out: string[] = [];
  let size = 0;
  for (let index = 0; size < length; index += 1) {
    const word = words[index % words.length] ?? '';
    out.push(word);
    size += word.length + 1;
  }
  return out.join(' ');
}

const guide = `# Client guide

Overview of the client library.

## Authentication

Call \`refreshToken\` before the session expires. The retry policy backs off with jitter.

### Token storage

Tokens are stored with \`token_store\` and \`parseHTTPResponse\`. Authorization headers use the bearer scheme.

#### Rotation

Rotate the signing key every 90 days. Retries stop after 5 attempts.

## Caching

The cache keeps one entry per revision. Retrying a request reuses the cache.

### Daemon state

The daemon keeps one canonical state and serializes commits. See SHA-256 digests.
`;

// A long section split into several overlapping parts. The phrase near a part boundary and terms in different parts.
const longSection = `# Long notes

## Boundary

${filler(PART_LENGTH - 30)} boundary phrase crosses here ${filler(PART_LENGTH)} lateterm appears only near the end ${filler(2000)}

## After

Short section after the long one with retry and cache.
`;

const mixed = `# 混在した文書

## 検索の設計

検索の設計では、Intl.Segmenterで日本語を分ける。ＡＢＣ全角とｶﾀｶﾅ半角も扱う。

## セッション

sessionの期限は12時間で、操作がなければ失効する。Session cache は版ごとに持つ。

### 回答

回答は、管理UIの送信でだけ確定する。retyr は綴り違いの例。
`;

const html = `<!doctype html><title>HTML handbook</title>
<h1>HTML handbook</h1><p>Static pages are shown without scripts.</p>
<h2>Retry</h2><p>Retry the request after the token expires.</p>
<script>retry()</script>`;

// Many short sections with the same words (like the performance fixture): ties and the per-document limit.
const repeated = [
  '# Repeated',
  ...Array.from(
    { length: 12 },
    (_, index) =>
      `## Part ${String(index)}\n\nThe retry policy and the cache. session ${String(index)}\n`,
  ),
].join('\n');

// Misspellings for fuzzy matches, and a literal match inside a longer word (found only by fuzzy matching as a term).
const typos = `# Typos

## Misspelled

Typos: retrys, cashe, sesion, tokne.

## Joined

aretry 日記 の例。
`;

const docs = [
  document(0, 'auth.md', fixture('auth.md')),
  document(1, 'design-notes.md', fixture('design-notes.md')),
  document(2, 'api/users.md', fixture('api/users.md')),
  document(3, 'ops/runbook.md', fixture('ops/runbook.md')),
  document(4, 'docs/guide.md', guide),
  document(5, 'docs/long.md', longSection),
  document(6, 'docs/mixed.md', mixed),
  document(7, 'site/handbook.html', html),
  document(8, 'docs/repeated.md', repeated),
  document(10, 'docs/typos.md', typos),
];

function buildIndex(): SearchIndex {
  const index = new SearchIndex();
  for (const entry of docs) index.upsert(entry);
  // A document being added (not committed) is never returned.
  const staged = document(9, 'docs/staged.md', `# Staged\n\nretry cache session token 認証\n`);
  const { sections, ...meta } = staged;
  index.begin(meta);
  index.append(meta.documentId, meta.revision, partsOf(sections));
  return index;
}

const QUERIES: Array<{ query: string; mode?: SearchMode; documents?: number[] }> = [
  { query: 'retry' },
  { query: 'retr' },
  { query: 're' },
  { query: 'r' },
  { query: 'retyr' },
  { query: 'retries' },
  { query: 'token' },
  { query: 'tok' },
  { query: 'refresh token' },
  { query: 'refreshToken' },
  { query: 'refresh_token' },
  { query: 'token_store' },
  { query: 'parse http response' },
  { query: 'authentication' },
  { query: 'auth' },
  { query: 'authorization bearer' },
  { query: 'rotation key' },
  { query: 'daemon state' },
  { query: 'cache revision' },
  { query: 'session cache' },
  { query: 'SHA-256' },
  { query: 'boundary phrase crosses' },
  { query: 'boundary lateterm' },
  { query: 'lateterm' },
  { query: 'lorem' },
  { query: '認証' },
  { query: '認' },
  { query: '有効期限' },
  { query: '検索の設計' },
  { query: '検索 設計' },
  { query: 'セッション' },
  { query: 'abc' },
  { query: 'カタカナ' },
  { query: '日本語 Intl.Segmenter' },
  { query: '回答' },
  { query: 'users' },
  { query: 'users.md' },
  { query: 'api/users.md' },
  { query: 'runbook' },
  { query: 'handbook' },
  { query: 'scripts' },
  { query: 'nothing-matches-this' },
  { query: 'cache' },
  { query: 'session' },
  { query: 'retry 日記' },
  { query: 'aretry' },
  { query: 'retry policy', mode: 'exact' },
  { query: 'Retry', mode: 'exact' },
  { query: 'セッションの', mode: 'exact' },
  { query: 're', mode: 'exact' },
  { query: 'api', mode: 'path' },
  { query: 'users.md', mode: 'path' },
  { query: 'docs/', mode: 'path' },
  { query: 'retry', documents: [4, 5, 8] },
  { query: 'session', documents: [6, 8] },
  { query: 'token', documents: [7] },
];

function runQueries(index: SearchIndex, results: Record<string, string[]>, prefix: string): void {
  for (const { query, mode = 'text', documents } of QUERIES) {
    const key = `${prefix}${mode}:${query}${documents ? ` [${documents.join(',')}]` : ''}`;
    const filter =
      documents === undefined
        ? null
        : new Set(documents.map((order) => document(order, '', '').documentId));
    results[key] = index
      .search({ query, mode, documents: filter })
      .map(
        (hit) =>
          `${hit.displayPath ?? ''}#${hit.sectionId} ${hit.matchKind} ${String(hit.score)} [${hit.headingPath.join(' > ')}] ${hit.excerpt}`,
      );
  }
}

describe('search results stay the same', () => {
  it('returns the recorded hits for a fixed corpus and queries', async () => {
    const results: Record<string, string[]> = {};
    runQueries(buildIndex(), results, '');

    // Replaced and removed entries are cleaned up lazily: MiniSearch drops their postings while it searches a term,
    // and until then they count in the scores. Each search changes what is left, so the results depend on which
    // terms earlier searches looked up. The same queries are recorded twice on an index with such entries.
    const dirty = buildIndex();
    dirty.remove(document(1, '', '').documentId);
    const updated = document(6, 'docs/mixed.md', `${mixed}\n## 追記\n\nretry cache の追記。\n`);
    dirty.upsert({ ...updated, revision: `rev_${'f'.repeat(64)}` });
    const aborted = document(11, 'docs/aborted.md', '# Aborted\n\nretry session token\n');
    const { sections, ...meta } = aborted;
    dirty.begin(meta);
    dirty.append(meta.documentId, meta.revision, partsOf(sections));
    dirty.abort(meta.documentId);
    expect((await dirty.retainedCounts(false))['miniDirt']).toBeGreaterThan(0);
    runQueries(dirty, results, 'before cleanup, first: ');
    runQueries(dirty, results, 'before cleanup, again: ');

    // A removed entry whose postings are still there when a later stage looks up a derived term.
    const small = new SearchIndex();
    for (const [order, body] of ['alpha beta', 'alphi betamax', 'betamax'].entries()) {
      small.upsert(document(20 + order, `notes/${String(order)}.md`, `# Note\n\n${body}\n`));
    }
    small.remove(document(22, '', '').documentId);
    for (const pass of ['first', 'again']) {
      results[`removed entry, ${pass}: text:alpha beta`] = small
        .search({ query: 'alpha beta', mode: 'text', documents: null })
        .map(
          (hit) =>
            `${hit.displayPath ?? ''}#${hit.sectionId} ${hit.matchKind} ${String(hit.score)}`,
        );
    }

    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      './search-ranking.snapshot.json',
    );
  });
});
