import { describe, expect, it } from 'vitest';

import { documentAt, inRepository, inWorktree } from './document.fixture.ts';
import { buildLabels, worktreeText } from './repository-labels.ts';

describe('labels', () => {
  it('names a repository by its folder, with parents only for repositories sharing a name', () => {
    const documents = [
      inRepository('/a/me/dotfiles', 'x.md'),
      inRepository('/a/you/dotfiles', 'y.md'),
      inRepository('/a/me/vde-open', 'z.md'),
    ];
    const labels = buildLabels(documents);
    expect([...labels.repository.values()]).toEqual(['me/dotfiles', 'you/dotfiles', 'vde-open']);
  });

  it('names a repository and a bare repository at the same place after their Git directories', () => {
    const bare = documentAt('/repos/app.git-work/a.md', {
      state: 'resolved',
      id: '/repos/app.git',
      nameSegments: ['repos', 'app'],
      checkout: { id: '/repos/app.git-work', kind: 'linked', name: 'w', branch: 'main' },
      pathInCheckout: ['a.md'],
    });
    const labels = buildLabels([inRepository('/repos/app', 'b.md'), bare]);
    expect([...labels.repository.values()]).toEqual(['app', 'app.git']);
  });

  it('shows the branch of a worktree, and its name when two would look the same', () => {
    const labels = buildLabels([
      inWorktree('/r/app', '/w/one', 'a.md', { name: 'one', branch: 'main' }),
      inWorktree('/r/app', '/w/two', 'b.md', { name: 'two', branch: 'main' }),
      inWorktree('/r/app', '/w/x', 'c.md', { name: 'x', branch: 'feature/x' }),
      inWorktree('/r/app', '/w/d', 'd.md', { name: 'd', branch: null }),
    ]);
    expect(Object.fromEntries(labels.worktree)).toEqual({
      '/w/one': 'main (one)',
      '/w/two': 'main (two)',
      '/w/x': 'feature/x',
      '/w/d': 'd',
    });
  });

  it('adds the worktree name to a branch only when they differ', () => {
    const labels = buildLabels([]);
    expect(worktreeText({ id: '/w', name: 'x', branch: 'x' }, labels)).toBe('x');
    expect(worktreeText({ id: '/w', name: 'x', branch: 'feature/x' }, labels)).toBe(
      'feature/x (x)',
    );
    expect(worktreeText({ id: '/w', name: 'x', branch: null }, labels)).toBe('x');
  });
});
