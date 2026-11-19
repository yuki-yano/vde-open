import type { RepositoryReason } from '@vde-open/shared';

import type { ListDocument, ListEntry } from './repository-labels.ts';

// The sidebar tree (spec 13.1), and the same tree on the phone. A view built from the paths and repositories of
// registered documents; it never touches the filesystem.
// The top level is one node per repository. Inside it, the main checkout comes first, then each linked worktree.
// Every node has a key that stays the same as long as it shows the same thing, so the DOM is not rebuilt
// (and focus is not lost) when, for example, a repository with one worktree turns into one with two.
export type TreeNode<D extends ListDocument = ListDocument> =
  | {
      kind: 'repository';
      key: string;
      name: string;
      // The repository folder (or the folder of an unresolved checkout) as a full path, for the tooltip.
      // null on the phone.
      location: string | null;
      // Why the checkout could not be verified. null for a verified repository.
      reason: RepositoryReason | null;
      // Set when the only child is one worktree: the row shows both, and the worktree's own row is hidden.
      merged: string | null;
      children: TreeNode<D>[];
    }
  | {
      kind: 'worktree';
      key: string;
      name: string;
      location: string | null;
      // The row is shown on the repository row instead (see merged). It stays for screen readers.
      hidden: boolean;
      children: TreeNode<D>[];
    }
  | { kind: 'group'; key: string; name: string; children: TreeNode<D>[] }
  | { kind: 'directory'; key: string; name: string; children: TreeNode<D>[] }
  | { kind: 'document'; key: string; name: string; document: D };

export const INPUT_GROUP_NAME = 'Input and generated documents';
export const OUTSIDE_GROUP_NAME = 'Outside a repository';
export const PENDING_GROUP_NAME = 'Checking repositories';
export const UNKNOWN_CHECKOUT_NAME = 'Unknown checkout';

interface Branch<D> {
  directories: Map<string, Branch<D>>;
  documents: Array<{ document: D; name: string }>;
}

function emptyBranch<D>(): Branch<D> {
  return { directories: new Map(), documents: [] };
}

function insert<D>(root: Branch<D>, directories: string[], document: D, name: string) {
  let branch = root;
  for (const segment of directories) {
    let next = branch.directories.get(segment);
    if (!next) {
      next = emptyBranch();
      branch.directories.set(segment, next);
    }
    branch = next;
  }
  branch.documents.push({ document, name });
}

function toNodes<D extends ListDocument>(branch: Branch<D>, parentKey: string): TreeNode<D>[] {
  const nodes: TreeNode<D>[] = [];
  for (const [name, child] of branch.directories) {
    // If the only child is a single directory, collapse it into one row like `a/b/c`.
    let label = name;
    let current = child;
    while (current.documents.length === 0 && current.directories.size === 1) {
      const [nextName, next] = [...current.directories.entries()][0] as [string, Branch<D>];
      label = `${label}/${nextName}`;
      current = next;
    }
    const key = `${parentKey}/${label}`;
    nodes.push({ kind: 'directory', key, name: label, children: toNodes(current, key) });
  }
  for (const { document, name } of branch.documents) {
    nodes.push({ kind: 'document', key: document.documentId, name, document });
  }
  return nodes;
}

interface RepositoryBucket<D> {
  key: string;
  name: string;
  location: string | null;
  reason: RepositoryReason | null;
  main: Branch<D>;
  unknown: Branch<D> | null;
  worktrees: Map<string, { name: string; location: string | null; branch: Branch<D> }>;
}

export function buildTree<D extends ListDocument>(entries: ListEntry<D>[]): TreeNode<D>[] {
  // Repositories in the order their first document appears in the list.
  const repositories = new Map<string, RepositoryBucket<D>>();
  const pending = emptyBranch<D>();
  const outside = emptyBranch<D>();
  const inputs: D[] = [];
  let hasPending = false;
  let hasOutside = false;

  for (const { document, place, directories, fileName } of entries) {
    if (place.kind === 'input') {
      inputs.push(document);
      continue;
    }
    if (place.kind === 'pending' || place.kind === 'outside') {
      // The PC shows the whole path, so documents in different places can be told apart without a shared parent.
      // The phone has no path here: only file names.
      insert(place.kind === 'pending' ? pending : outside, directories, document, fileName);
      if (place.kind === 'pending') hasPending = true;
      else hasOutside = true;
      continue;
    }
    let bucket = repositories.get(place.key);
    if (!bucket) {
      bucket = {
        key: place.key,
        name: place.name,
        location: place.location,
        reason: place.kind === 'unresolved' ? place.reason : null,
        main: emptyBranch(),
        unknown: null,
        worktrees: new Map(),
      };
      repositories.set(place.key, bucket);
    }
    const checkout = place.kind === 'repository' ? place.checkout : undefined;
    if (checkout?.kind === 'unknown') {
      bucket.unknown ??= emptyBranch();
      insert(bucket.unknown, directories, document, fileName);
    } else if (checkout?.kind === 'linked') {
      let worktree = bucket.worktrees.get(checkout.key);
      if (!worktree) {
        worktree = { name: checkout.label, location: checkout.location, branch: emptyBranch() };
        bucket.worktrees.set(checkout.key, worktree);
      }
      insert(worktree.branch, directories, document, fileName);
    } else {
      insert(bucket.main, directories, document, fileName);
    }
  }

  const nodes: TreeNode<D>[] = [];
  for (const bucket of repositories.values()) {
    const children = toNodes(bucket.main, bucket.key);
    if (bucket.unknown) {
      const key = `${bucket.key}\0unknown`;
      children.push({
        kind: 'group',
        key,
        name: UNKNOWN_CHECKOUT_NAME,
        children: toNodes(bucket.unknown, key),
      });
    }
    const onlyWorktree =
      bucket.main.documents.length === 0 &&
      bucket.main.directories.size === 0 &&
      bucket.unknown === null &&
      bucket.worktrees.size === 1;
    for (const [id, worktree] of bucket.worktrees) {
      const key = `${bucket.key}\0worktree:${id}`;
      children.push({
        kind: 'worktree',
        key,
        name: worktree.name,
        location: worktree.location,
        hidden: onlyWorktree,
        children: toNodes(worktree.branch, key),
      });
    }
    nodes.push({
      kind: 'repository',
      key: bucket.key,
      name: bucket.name,
      location: bucket.location,
      reason: bucket.reason,
      merged: onlyWorktree ? ([...bucket.worktrees.values()][0]?.name ?? null) : null,
      children,
    });
  }
  if (hasPending) {
    nodes.push({
      kind: 'group',
      key: 'group:pending',
      name: PENDING_GROUP_NAME,
      children: toNodes(pending, 'group:pending'),
    });
  }
  if (hasOutside) {
    nodes.push({
      kind: 'group',
      key: 'group:outside',
      name: OUTSIDE_GROUP_NAME,
      children: toNodes(outside, 'group:outside'),
    });
  }
  if (inputs.length > 0) {
    nodes.push({
      kind: 'group',
      key: 'group:input',
      name: INPUT_GROUP_NAME,
      children: inputs.map((document) => ({
        kind: 'document',
        key: document.documentId,
        name: document.title,
        document,
      })),
    });
  }
  return nodes;
}
