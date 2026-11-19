import { buildLabels, type DocumentSummary } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import {
  documentAt,
  inRepository,
  inWorktree,
} from '../../../../packages/shared/src/document.fixture.ts';
import {
  locationText,
  pcEntry,
  shortDirectories,
  splitFileName,
  visible,
} from './repository-labels.ts';

describe('short directories in the flat list', () => {
  const shown = (documents: DocumentSummary[]) => {
    const labels = buildLabels(documents);
    const short = shortDirectories(documents.map((document) => pcEntry(document, labels)));
    return documents.map((document) => {
      const entry = short.get(document.documentId);
      return `${entry?.elided ? '…/' : ''}${entry?.shown.join('/') ?? ''}`;
    });
  };

  it('shows only the nearest directory', () => {
    expect(
      shown([inRepository('/r/app', 'docs/old/design.md'), inRepository('/r/app', 'README.md')]),
    ).toEqual(['…/old', '']);
  });

  it('shows more directories where two files with the same name would look the same', () => {
    expect(
      shown([
        inRepository('/r/app', 'a/docs/README.md'),
        inRepository('/r/app', 'b/docs/README.md'),
        inRepository('/r/app', 'c/guide/README.md'),
      ]),
    ).toEqual(['a/docs', 'b/docs', '…/guide']);
  });

  it('handles many files with the same name, each told apart by one more directory', () => {
    const documents = Array.from({ length: 300 }, (_, index) =>
      inRepository('/r/app', `docs/area${String(index % 3)}/item${String(index)}/index.md`),
    );
    const short = shown(documents);
    expect(new Set(short).size).toBe(300);
    expect(short[0]).toBe('…/item0');
  });

  it('compares only within the same checkout, and outside documents among themselves', () => {
    expect(
      shown([
        inRepository('/r/app', 'x/docs/a.md'),
        inWorktree('/r/app', '/r/app/.git/wt/w', 'y/docs/a.md'),
        documentAt('/home/u/one/docs/a.md'),
        documentAt('/home/u/two/docs/a.md'),
      ]),
    ).toEqual(['…/docs', '…/docs', '…/one/docs', '…/two/docs']);
  });
});

describe('labels', () => {
  it('describes the whole location', () => {
    const documents = [
      inWorktree('/r/app', '/w/x', 'docs/plan.md', { name: 'x', branch: 'feature/x' }),
      documentAt('/home/u/notes/a.md'),
      documentAt('/mnt/slow/b.md', { state: 'pending' }),
      documentAt(null),
    ];
    const labels = buildLabels(documents);
    expect(documents.map((document) => locationText(document, labels))).toEqual([
      'app · worktree feature/x (x) · docs/plan.md',
      '/home/u/notes/a.md',
      'Checking repository… /mnt/slow/b.md',
      'Standard input',
    ]);
  });
});

describe('text helpers', () => {
  it('splits the extension from the stem', () => {
    expect(splitFileName('design.md')).toEqual({ stem: 'design', extension: '.md' });
    expect(splitFileName('archive.tar.html')).toEqual({ stem: 'archive.tar', extension: '.html' });
    expect(splitFileName('.gitignore')).toEqual({ stem: '.gitignore', extension: '' });
    expect(splitFileName('README')).toEqual({ stem: 'README', extension: '' });
  });

  it('shows bidirectional controls instead of letting them reorder the text', () => {
    expect(visible('feature/a‮b')).toBe('feature/a<U+202E>b');
    expect(visible('plain')).toBe('plain');
  });
});
