import { describe, expect, it } from 'vitest';

import { documentAt, inRepository, inWorktree } from './document.fixture.ts';
import {
  buildTree,
  INPUT_GROUP_NAME,
  OUTSIDE_GROUP_NAME,
  PENDING_GROUP_NAME,
  UNKNOWN_CHECKOUT_NAME,
  type TreeNode,
} from './tree.ts';

// Names of each node, nested. Repository and worktree rows are marked, and a hidden worktree row shows as such.
function shape(nodes: TreeNode[]): unknown {
  return nodes.map((node) => {
    switch (node.kind) {
      case 'document':
        return node.name;
      case 'repository':
        return {
          [`[repo] ${node.name}${node.merged === null ? '' : ` ⑂ ${node.merged}`}${node.reason === null ? '' : ` !${node.reason}`}`]:
            shape(node.children),
        };
      case 'worktree':
        return { [`${node.hidden ? '(hidden) ' : ''}⑂ ${node.name}`]: shape(node.children) };
      default:
        return { [node.name]: shape(node.children) };
    }
  });
}

describe('DOC-007 tree grouped by repository', () => {
  it('shows the repository as the top row even when it is the only one, with one document', () => {
    expect(shape(buildTree([inRepository('/r/vde-open', 'docs/design.md')]))).toEqual([
      { '[repo] vde-open': [{ docs: ['design.md'] }] },
    ]);
  });

  it('builds the path within the checkout and collapses single-child directories', () => {
    const tree = buildTree([
      inRepository('/r/proj', 'docs/a.md'),
      inRepository('/r/proj', 'docs/guide/deep/b.md'),
      inRepository('/r/proj', 'README.md'),
    ]);
    expect(shape(tree)).toEqual([
      { '[repo] proj': [{ docs: [{ 'guide/deep': ['b.md'] }, 'a.md'] }, 'README.md'] },
    ]);
  });

  it('orders repositories by their first document and keeps docs/a.md of each apart', () => {
    const tree = buildTree([
      inRepository('/w/beta', 'docs/a.md'),
      inRepository('/w/alpha', 'docs/a.md'),
      inRepository('/w/beta', 'b.md'),
    ]);
    expect(shape(tree)).toEqual([
      { '[repo] beta': [{ docs: ['a.md'] }, 'b.md'] },
      { '[repo] alpha': [{ docs: ['a.md'] }] },
    ]);
  });

  it('tells same-named repositories apart by their parent directory', () => {
    const tree = buildTree([
      inRepository('/me/dotfiles', 'a.md'),
      inRepository('/you/dotfiles', 'b.md'),
    ]);
    expect(shape(tree)).toEqual([
      { '[repo] me/dotfiles': ['a.md'] },
      { '[repo] you/dotfiles': ['b.md'] },
    ]);
  });

  it('puts worktrees under their repository, after the main checkout', () => {
    const tree = buildTree([
      inWorktree('/r/app', '/r/app/.git/wt/feature/x', 'docs/plan.md', { branch: 'feature/x' }),
      inRepository('/r/app', 'docs/notes.md'),
    ]);
    expect(shape(tree)).toEqual([
      {
        '[repo] app': [{ docs: ['notes.md'] }, { '⑂ feature/x': [{ docs: ['plan.md'] }] }],
      },
    ]);
  });

  it('shows the repository and its only worktree on one row, keeping the worktree node', () => {
    const tree = buildTree([
      inWorktree('/r/app', '/r/app/.git/wt/feature/x', 'docs/plan.md', { branch: 'feature/x' }),
    ]);
    expect(shape(tree)).toEqual([
      { '[repo] app ⑂ feature/x': [{ '(hidden) ⑂ feature/x': [{ docs: ['plan.md'] }] }] },
    ]);
  });

  it('keeps the keys of the worktree and document nodes when a second checkout appears', () => {
    const plan = inWorktree('/r/app', '/r/app/.git/wt/x', 'plan.md');
    const keysOf = (nodes: TreeNode[]): string[] =>
      nodes.flatMap((node) => [node.key, ...('children' in node ? keysOf(node.children) : [])]);
    const one = keysOf(buildTree([plan]));
    const two = keysOf(buildTree([plan, inRepository('/r/app', 'a.md')]));
    for (const key of one) expect(two).toContain(key);
  });

  it('adds the worktree name when two worktrees show the same branch', () => {
    const tree = buildTree([
      inWorktree('/r/app', '/r/app/.git/wt/one', 'a.md', { name: 'one', branch: 'main' }),
      inWorktree('/r/app', '/r/app/.git/wt/two', 'b.md', { name: 'two', branch: 'main' }),
      // A detached worktree named like another's branch.
      inWorktree('/r/app', '/r/app/.git/wt/dev', 'c.md', { name: 'dev', branch: null }),
      inWorktree('/r/app', '/r/app/.git/wt/three', 'd.md', { name: 'three', branch: 'dev' }),
    ]);
    expect(shape(tree)).toEqual([
      {
        '[repo] app': [
          { '⑂ main (one)': ['a.md'] },
          { '⑂ main (two)': ['b.md'] },
          { '⑂ dev': ['c.md'] },
          { '⑂ dev (three)': ['d.md'] },
        ],
      },
    ]);
  });

  it('places documents in a removed worktree under an unknown checkout', () => {
    const removed = documentAt('/r/app/.git/wt/x/a.md', {
      state: 'resolved',
      id: '/r/app/.git',
      nameSegments: ['r', 'app'],
      checkout: null,
      pathInCheckout: ['.git', 'wt', 'x', 'a.md'],
    });
    expect(shape(buildTree([inRepository('/r/app', 'b.md'), removed]))).toEqual([
      { '[repo] app': ['b.md', { [UNKNOWN_CHECKOUT_NAME]: [{ '.git/wt/x': ['a.md'] }] }] },
    ]);
  });

  it('shows an unresolved checkout on its own, not in the repository above it', () => {
    const unresolved = documentAt('/r/app/vendor/copy/a.md', {
      state: 'unresolved',
      id: '/r/app/vendor/copy',
      nameSegments: ['r', 'app', 'vendor', 'copy'],
      pathInCheckout: ['a.md'],
      reason: 'link-mismatch',
    });
    expect(shape(buildTree([inRepository('/r/app', 'b.md'), unresolved]))).toEqual([
      { '[repo] app': ['b.md'] },
      { '[repo] copy !link-mismatch': ['a.md'] },
    ]);
  });

  it('groups pending, outside, and input documents after the repositories', () => {
    const tree = buildTree([
      documentAt(null, null, 'レビュー'),
      documentAt('/home/u/notes/plan.md'),
      documentAt('/home/u/other/x.md'),
      documentAt('/mnt/slow/y.md', { state: 'pending' }),
      inRepository('/r/app', 'a.md'),
    ]);
    expect(shape(tree)).toEqual([
      { '[repo] app': ['a.md'] },
      { [PENDING_GROUP_NAME]: [{ 'mnt/slow': ['y.md'] }] },
      // The whole path stays (no shared parent is dropped); single-child directories collapse.
      { [OUTSIDE_GROUP_NAME]: [{ 'home/u': [{ notes: ['plan.md'] }, { other: ['x.md'] }] }] },
      { [INPUT_GROUP_NAME]: ['レビュー'] },
    ]);
  });
});
