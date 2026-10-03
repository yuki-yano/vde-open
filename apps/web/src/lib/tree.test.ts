import type { DocumentSummary } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import { buildTree, INPUT_GROUP_NAME, type TreeNode } from './tree.ts';

let counter = 0;
function document(path: string | null, title = 'doc'): DocumentSummary {
  counter += 1;
  return {
    documentId: `doc_00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    key: null,
    format: 'markdown',
    sourceKind: path === null ? 'stdin' : 'file',
    title,
    displayPath: path,
    pathSegments: path === null ? [] : path.split('/').filter(Boolean),
    revision: null,
    sourceState: 'ready',
    searchState: 'excluded',
    openedAt: '',
    updatedAt: '',
    order: counter,
    pendingRequestIds: [],
    htmlMode: null,
    interactiveAllowed: false,
  };
}

function shape(nodes: TreeNode[]): unknown {
  return nodes.map((node) =>
    node.kind === 'directory' ? { [node.name]: shape(node.children) } : node.name,
  );
}

describe('DOC-007 tree from paths', () => {
  it('drops the shared parent directories and collapses single-child directories into one row', () => {
    const tree = buildTree([
      document('/home/u/proj/docs/a.md'),
      document('/home/u/proj/docs/guide/deep/b.md'),
      document('/home/u/proj/README.md'),
    ]);
    expect(shape(tree)).toEqual([{ docs: [{ 'guide/deep': ['b.md'] }, 'a.md'] }, 'README.md']);
  });

  it('same-named docs/a.md under different roots do not collide and the root can be told apart', () => {
    const tree = buildTree([document('/work/alpha/docs/a.md'), document('/work/beta/docs/a.md')]);
    expect(shape(tree)).toEqual([{ 'alpha/docs': ['a.md'] }, { 'beta/docs': ['a.md'] }]);
  });

  it('with a single document, shows only the file without its parent directories', () => {
    expect(shape(buildTree([document('/a/b/c.md')]))).toEqual(['c.md']);
  });

  it('groups stdin and generated documents under a display-only parent', () => {
    const tree = buildTree([document('/a/b.md'), document(null, 'レビュー')]);
    expect(shape(tree)).toEqual(['b.md', { [INPUT_GROUP_NAME]: ['レビュー'] }]);
  });
});
