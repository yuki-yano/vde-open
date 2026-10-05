import type { DocumentSummary, RepositoryReason } from '@vde-open/shared';

import {
  buildLabels,
  directoriesOf,
  fileNameOf,
  placementOf,
  type Labels,
} from './repository-labels.ts';

// The sidebar tree (spec 13.1). A view built from the paths and repositories of registered documents; it never touches the filesystem.
// The top level is one node per repository. Inside it, the main checkout comes first, then each linked worktree.
// Every node has a key that stays the same as long as it shows the same thing, so the DOM is not rebuilt
// (and focus is not lost) when, for example, a repository with one worktree turns into one with two.
export type TreeNode =
  | {
      kind: 'repository';
      key: string;
      name: string;
      // The repository folder (or the folder of an unresolved checkout) as a full path, for the tooltip.
      location: string;
      // Why the checkout could not be verified. null for a verified repository.
      reason: RepositoryReason | null;
      // Set when the only child is one worktree: the row shows both, and the worktree's own row is hidden.
      merged: string | null;
      children: TreeNode[];
    }
  | {
      kind: 'worktree';
      key: string;
      name: string;
      location: string;
      // The row is shown on the repository row instead (see merged). It stays for screen readers.
      hidden: boolean;
      children: TreeNode[];
    }
  | { kind: 'group'; key: string; name: string; children: TreeNode[] }
  | { kind: 'directory'; key: string; name: string; children: TreeNode[] }
  | { kind: 'document'; key: string; name: string; document: DocumentSummary };

export const INPUT_GROUP_NAME = 'Input and generated documents';
export const OUTSIDE_GROUP_NAME = 'Outside a repository';
export const PENDING_GROUP_NAME = 'Checking repositories';
export const UNKNOWN_CHECKOUT_NAME = 'Unknown checkout';

interface Branch {
  directories: Map<string, Branch>;
  documents: Array<{ document: DocumentSummary; name: string }>;
}

function emptyBranch(): Branch {
  return { directories: new Map(), documents: [] };
}

function insert(root: Branch, directories: string[], document: DocumentSummary, name: string) {
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

function toNodes(branch: Branch, parentKey: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [name, child] of branch.directories) {
    // If the only child is a single directory, collapse it into one row like `a/b/c`.
    let label = name;
    let current = child;
    while (current.documents.length === 0 && current.directories.size === 1) {
      const [nextName, next] = [...current.directories.entries()][0] as [string, Branch];
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

// The folder of a repository for the tooltip: its common Git directory without the trailing .git.
function folderOf(id: string): string {
  return id.replace(/[\\/]\.git$/, '');
}

interface RepositoryBucket {
  key: string;
  name: string;
  location: string;
  reason: RepositoryReason | null;
  main: Branch;
  unknown: Branch | null;
  worktrees: Map<string, { name: string; location: string; branch: Branch }>;
}

export function buildTree(
  documents: DocumentSummary[],
  labels: Labels = buildLabels(documents),
): TreeNode[] {
  // Repositories in the order their first document appears in the list.
  const repositories = new Map<string, RepositoryBucket>();
  const pending = emptyBranch();
  const outside = emptyBranch();
  const inputs: DocumentSummary[] = [];
  let hasPending = false;
  let hasOutside = false;

  for (const document of documents) {
    const placement = placementOf(document);
    if (placement.kind === 'input') {
      inputs.push(document);
      continue;
    }
    if (placement.kind === 'pending' || placement.kind === 'outside') {
      // The whole path is shown, so documents in different places can be told apart without a shared parent.
      insert(
        placement.kind === 'pending' ? pending : outside,
        document.pathSegments.slice(0, -1),
        document,
        fileNameOf(document),
      );
      if (placement.kind === 'pending') hasPending = true;
      else hasOutside = true;
      continue;
    }
    let bucket = repositories.get(placement.key);
    if (!bucket) {
      bucket = {
        key: placement.key,
        name:
          labels.repository.get(placement.key) ?? placement.repository.nameSegments.at(-1) ?? '',
        location: folderOf(placement.repository.id),
        reason: placement.kind === 'unresolved' ? placement.repository.reason : null,
        main: emptyBranch(),
        unknown: null,
        worktrees: new Map(),
      };
      repositories.set(placement.key, bucket);
    }
    const directories = directoriesOf(document);
    const name = fileNameOf(document);
    const checkout = placement.kind === 'repository' ? placement.repository.checkout : undefined;
    if (checkout === null) {
      bucket.unknown ??= emptyBranch();
      insert(bucket.unknown, directories, document, name);
    } else if (checkout?.kind === 'linked') {
      let worktree = bucket.worktrees.get(checkout.id);
      if (!worktree) {
        worktree = {
          name: labels.worktree.get(checkout.id) ?? checkout.name,
          location: checkout.id,
          branch: emptyBranch(),
        };
        bucket.worktrees.set(checkout.id, worktree);
      }
      insert(worktree.branch, directories, document, name);
    } else {
      insert(bucket.main, directories, document, name);
    }
  }

  const nodes: TreeNode[] = [];
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
