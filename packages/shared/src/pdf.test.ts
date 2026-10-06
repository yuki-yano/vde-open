import { describe, expect, it } from 'vitest';

import { pdfFileName } from './pdf.ts';

describe('file name of an exported PDF', () => {
  it('replaces the extension of the source file name', () => {
    expect(pdfFileName({ displayPath: '~/repos/app/docs/README.md', title: 'App' })).toBe(
      'README.pdf',
    );
    expect(pdfFileName({ displayPath: 'docs/設計.markdown', title: '設計' })).toBe('設計.pdf');
    expect(pdfFileName({ displayPath: 'C:\\work\\notes.md', title: 'x' })).toBe('notes.pdf');
    expect(pdfFileName({ displayPath: 'docs/.hidden', title: 'x' })).toBe('hidden.pdf');
  });

  it('uses the title for a document without a path', () => {
    expect(pdfFileName({ displayPath: null, title: '会議メモ: 10/06 "決定事項"' })).toBe(
      '会議メモ_ 10_06 _決定事項_.pdf',
    );
    expect(pdfFileName({ displayPath: null, title: 'a\u0000b\nc' })).toBe('a_b_c.pdf');
    expect(pdfFileName({ displayPath: null, title: ' ... ' })).toBe('document.pdf');
    expect(pdfFileName({ displayPath: null, title: '' })).toBe('document.pdf');
  });

  it('keeps the name within 200 bytes of UTF-8 without splitting a character', () => {
    const name = pdfFileName({ displayPath: null, title: '設'.repeat(160) });
    // 66 characters of 3 bytes are 198 bytes; one more would be 201.
    expect(name).toBe(`${'設'.repeat(66)}.pdf`);
    expect(pdfFileName({ displayPath: null, title: '😀'.repeat(60) })).toBe(
      `${'😀'.repeat(50)}.pdf`,
    );
  });
});
