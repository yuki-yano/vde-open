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

describe('DOC-007 pathからのtree', () => {
  it('共通の親directoryを省き、子が1つのdirectoryを1行へまとめる', () => {
    const tree = buildTree([
      document('/home/u/proj/docs/a.md'),
      document('/home/u/proj/docs/guide/deep/b.md'),
      document('/home/u/proj/README.md'),
    ]);
    expect(shape(tree)).toEqual([{ docs: [{ 'guide/deep': ['b.md'] }, 'a.md'] }, 'README.md']);
  });

  it('rootが違う同名のdocs/a.mdが衝突せず、どのrootかを見分けられる', () => {
    const tree = buildTree([document('/work/alpha/docs/a.md'), document('/work/beta/docs/a.md')]);
    expect(shape(tree)).toEqual([{ 'alpha/docs': ['a.md'] }, { 'beta/docs': ['a.md'] }]);
  });

  it('文書が1件なら、親directoryを出さずにfileだけを表示する', () => {
    expect(shape(buildTree([document('/a/b/c.md')]))).toEqual(['c.md']);
  });

  it('stdinと生成文書は、表示上の親にまとめる', () => {
    const tree = buildTree([document('/a/b.md'), document(null, 'レビュー')]);
    expect(shape(tree)).toEqual(['b.md', { [INPUT_GROUP_NAME]: ['レビュー'] }]);
  });
});
