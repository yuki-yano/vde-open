// Document summaries for tests of the list and the tree.
import type { DocumentRepository, DocumentSummary } from '@vde-open/shared';

let counter = 0;
export const segments = (path: string) => path.split('/').filter(Boolean);

export function documentAt(
  path: string | null,
  repository: DocumentRepository = null,
  title = 'doc',
): DocumentSummary {
  counter += 1;
  return {
    documentId: `doc_00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    key: null,
    format: 'markdown',
    sourceKind: path === null ? 'stdin' : 'file',
    title,
    displayPath: path,
    pathSegments: path === null ? [] : segments(path),
    canonicalPath: path,
    repository: path === null ? null : repository,
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

// A document in the main checkout of the repository at `root`.
export function inRepository(root: string, path: string): DocumentSummary {
  return documentAt(`${root}/${path}`, {
    state: 'resolved',
    id: `${root}/.git`,
    nameSegments: segments(root),
    checkout: { id: root, kind: 'main' },
    pathInCheckout: segments(path),
  });
}

// A document in a linked worktree of the repository at `root`.
export function inWorktree(
  root: string,
  checkout: string,
  path: string,
  options: { name?: string; branch?: string | null } = {},
): DocumentSummary {
  const name = options.name ?? checkout.split('/').at(-1) ?? '';
  return documentAt(`${checkout}/${path}`, {
    state: 'resolved',
    id: `${root}/.git`,
    nameSegments: segments(root),
    checkout: {
      id: checkout,
      kind: 'linked',
      name,
      branch: options.branch === undefined ? name : options.branch,
    },
    pathInCheckout: segments(path),
  });
}
