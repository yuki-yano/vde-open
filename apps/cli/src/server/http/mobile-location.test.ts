import { createHash } from 'node:crypto';

import { buildLabels, type DocumentSummary } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import {
  documentAt,
  inRepository,
  inWorktree,
  segments,
} from '../../../../../packages/shared/src/document.fixture.ts';
import { mobileLocationOf } from './mobile-location.ts';

const opaque = (value: string) => createHash('sha256').update(value).digest('base64url');
const locations = (documents: DocumentSummary[]) => {
  const labels = buildLabels(documents);
  return documents.map((document) => mobileLocationOf(document, labels, opaque));
};
const names = (documents: DocumentSummary[]) =>
  locations(documents).map((location) => ('name' in location ? location.name : null));

describe('where a document is, as the phone receives it', () => {
  it('names the repository, worktree, and path in the checkout, and nothing of the paths of this computer', () => {
    const documents = [
      inRepository('/Users/alice/src/app', 'docs/a.md'),
      inWorktree('/Users/alice/src/app', '/Users/alice/wt/app-x', 'plan.md', {
        branch: 'feature/x',
      }),
      documentAt('/Users/alice/notes/c.md'),
      documentAt('/Users/alice/new/d.md', { state: 'pending' }),
      documentAt('/Users/alice/broken/e.md', {
        state: 'unresolved',
        id: '/Users/alice/broken',
        nameSegments: segments('/Users/alice/broken'),
        pathInCheckout: ['e.md'],
        reason: 'unreadable',
      }),
      documentAt(null),
      // Checkouts at the root of the disk.
      inRepository('/', 'home/alice/private/notes.md'),
      inWorktree('/repos/tool', '/', 'home/alice/private/plan.md'),
    ];
    const [main, linked, outside, pending, unresolved, stdin, root, linkedRoot] =
      locations(documents);
    expect(main).toMatchObject({
      kind: 'repository',
      name: 'app',
      checkout: { kind: 'main' },
      path: ['docs', 'a.md'],
    });
    expect(linked).toMatchObject({
      kind: 'repository',
      name: 'app',
      checkout: { kind: 'linked', label: 'feature/x', full: 'feature/x (app-x)' },
      path: ['plan.md'],
    });
    expect(outside).toEqual({ kind: 'outside', fileName: 'c.md' });
    expect(pending).toEqual({ kind: 'pending', fileName: 'd.md' });
    expect(unresolved).toMatchObject({ kind: 'unresolved', name: 'broken', path: ['e.md'] });
    expect(stdin).toEqual({ kind: 'stdin' });
    expect(root).toMatchObject({ kind: 'repository', path: ['notes.md'] });
    expect(linkedRoot).toMatchObject({ kind: 'repository', path: ['plan.md'] });
    const sent = JSON.stringify([
      main,
      linked,
      outside,
      pending,
      unresolved,
      stdin,
      root,
      linkedRoot,
    ]);
    for (const secret of ['/Users', 'alice', '.git', 'wt/']) expect(sent).not.toContain(secret);
  });

  it('keeps one parent folder to tell same-named repositories apart, and never more of their paths', () => {
    expect(
      names([
        inRepository('/Users/alice/a/app', 'x.md'),
        inRepository('/Users/alice/b/app', 'y.md'),
      ]),
    ).toEqual(['a/app', 'b/app']);
    // The PC needs the whole path (or most of it) for these; the phone gets the name and part of its key.
    for (const roots of [
      ['/Users/alice/src/app', '/Volumes/backup/Users/alice/src/app'],
      ['C:/app', 'D:/app'],
    ]) {
      const named = names(roots.map((root) => inRepository(root, 'x.md')));
      for (const name of named) expect(name).toMatch(/^app \([\w-]{6}\)$/);
      expect(new Set(named).size).toBe(2);
    }
  });
});
