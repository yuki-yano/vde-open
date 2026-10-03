import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { HTML_STATIC_PARSER_PROFILE, MARKDOWN_PARSER_PROFILE } from '@vde-open/document';
import { describe, expect, it } from 'vitest';

import { computeRevision, sha256Hex } from './revision.ts';

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../../../tests/fixtures/handoff/${name}`, import.meta.url));
const fixtureBytes = (name: string) => readFileSync(fixturePath(name));
const fixtureJson = (name: string) =>
  JSON.parse(readFileSync(fixturePath(name), 'utf8')) as unknown;

describe('revision computation', () => {
  it('matches the revisions in the handoff response examples', () => {
    const search = fixtureJson('search-response.json') as {
      data: { hits: Array<{ revision: string }> };
    };
    const feedback = fixtureJson('feedback-response.json') as { data: { revision: string } };

    expect(
      computeRevision({
        format: 'markdown',
        sourceSha256: sha256Hex(fixtureBytes('auth.md')),
        parserProfileVersion: MARKDOWN_PARSER_PROFILE,
        assets: [],
      }),
    ).toBe(search.data.hits[0]?.revision);
    expect(
      computeRevision({
        format: 'html',
        sourceSha256: sha256Hex(fixtureBytes('review.html')),
        parserProfileVersion: HTML_STATIC_PARSER_PROFILE,
        assets: [],
      }),
    ).toBe(feedback.data.revision);
  });

  it('is independent of asset order and changes when asset content changes', () => {
    const base = {
      format: 'html' as const,
      sourceSha256: 'a'.repeat(64),
      parserProfileVersion: 'p',
    };
    const css = {
      logicalPath: 'a.css',
      mime: 'text/css',
      role: 'stylesheet',
      sha256: 'b'.repeat(64),
    };
    const img = { logicalPath: 'b.png', mime: 'image/png', role: 'image', sha256: 'c'.repeat(64) };
    expect(computeRevision({ ...base, assets: [css, img] })).toBe(
      computeRevision({ ...base, assets: [img, css] }),
    );
    expect(computeRevision({ ...base, assets: [css] })).not.toBe(
      computeRevision({ ...base, assets: [{ ...css, sha256: 'd'.repeat(64) }] }),
    );
  });
});
