import type { DocumentRepository, DocumentSummary } from './documents.ts';

// The names the PC list shows for repositories and worktrees. Derived from the list of open documents only, so the
// daemon gives the phone exactly the names the PC shows.

type Repository = NonNullable<DocumentRepository>;
type Resolved = Extract<Repository, { state: 'resolved' }>;
type Unresolved = Extract<Repository, { state: 'unresolved' }>;

// The group a document is placed in.
export type Placement =
  | { kind: 'repository'; key: string; repository: Resolved }
  | { kind: 'unresolved'; key: string; repository: Unresolved }
  | { kind: 'pending' }
  | { kind: 'outside' }
  | { kind: 'input' };

export function placementOf(
  document: Pick<DocumentSummary, 'sourceKind' | 'repository'>,
): Placement {
  if (document.sourceKind !== 'file') return { kind: 'input' };
  const repository = document.repository;
  if (repository === null) return { kind: 'outside' };
  if (repository.state === 'pending') return { kind: 'pending' };
  if (repository.state === 'unresolved') {
    return { kind: 'unresolved', key: `unresolved:${repository.id}`, repository };
  }
  return { kind: 'repository', key: `repository:${repository.id}`, repository };
}

// The shortest trailing part of each path that tells it apart from the others with the same last segment.
// Used for repository names: "dotfiles" alone, or "me/dotfiles" and "other/dotfiles" when both are open.
function distinctSuffixes(paths: Map<string, string[]>): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const [key, segments] of paths) {
    const name = segments.at(-1) ?? '';
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }
  for (const keys of byName.values()) {
    for (const key of keys) {
      const segments = paths.get(key) ?? [];
      let length = 1;
      const suffix = (of: string[], size: number) => of.slice(-size).join('/');
      while (
        length < segments.length &&
        keys.some(
          (other) =>
            other !== key && suffix(paths.get(other) ?? [], length) === suffix(segments, length),
        )
      ) {
        length += 1;
      }
      labels.set(key, suffix(segments, length));
    }
  }
  return labels;
}

export interface Labels {
  // The display name of a repository (or of the folder of an unresolved checkout), by placement key.
  repository: Map<string, string>;
  // The display name of each linked worktree, by checkout id.
  worktree: Map<string, string>;
}

// Names depend on which documents are open: opening or closing a repository with the same name changes them.
export function buildLabels(documents: DocumentSummary[]): Labels {
  const locations = new Map<string, string[]>();
  const ids = new Map<string, string>();
  // Linked checkouts of each repository, with their name and branch.
  const checkouts = new Map<string, Map<string, { name: string; branch: string | null }>>();
  for (const document of documents) {
    const placement = placementOf(document);
    if (placement.kind !== 'repository' && placement.kind !== 'unresolved') continue;
    locations.set(placement.key, placement.repository.nameSegments);
    ids.set(placement.key, placement.repository.id);
    if (placement.kind !== 'repository') continue;
    const checkout = placement.repository.checkout;
    if (checkout?.kind !== 'linked') continue;
    let linked = checkouts.get(placement.key);
    if (!linked) {
      linked = new Map();
      checkouts.set(placement.key, linked);
    }
    linked.set(checkout.id, { name: checkout.name, branch: checkout.branch });
  }

  // A worktree shows its branch, or its name when there is no branch.
  // When two worktrees of the same repository would show the same text, every one of them also shows its name.
  const worktree = new Map<string, string>();
  for (const linked of checkouts.values()) {
    const shown = new Map<string, string[]>();
    for (const [id, { name, branch }] of linked) {
      const text = branch ?? name;
      shown.set(text, [...(shown.get(text) ?? []), id]);
    }
    for (const [text, sharing] of shown) {
      for (const id of sharing) {
        const name = linked.get(id)?.name ?? '';
        worktree.set(id, sharing.length > 1 && name !== text ? `${text} (${name})` : text);
      }
    }
  }
  // Two repositories can have the same location: a repository at app/ and a bare one at app.git.
  // Those are named after their Git directory instead (app and app.git).
  const byLocation = new Map<string, string[]>();
  for (const [key, segments] of locations) {
    const location = segments.join('/');
    byLocation.set(location, [...(byLocation.get(location) ?? []), key]);
  }
  for (const keys of byLocation.values()) {
    if (keys.length < 2) continue;
    for (const key of keys) {
      const raw = (ids.get(key) ?? '').split(/[\\/]/).filter((part) => part !== '');
      locations.set(key, raw.at(-1) === '.git' ? raw.slice(0, -1) : raw);
    }
  }
  return { repository: distinctSuffixes(locations), worktree };
}

// A worktree in full: its branch, and its own name too when that differs (the branch can be stale, the name cannot).
export function worktreeText(
  checkout: { id: string; name: string; branch: string | null },
  labels: Labels,
): string {
  const label = labels.worktree.get(checkout.id) ?? checkout.branch ?? checkout.name;
  const named = label === checkout.name || label.endsWith(`(${checkout.name})`);
  return named ? label : `${label} (${checkout.name})`;
}
