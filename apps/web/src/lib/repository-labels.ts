import type { DocumentFormat, DocumentSummary, RepositoryReason } from '@vde-open/shared';

// Names and locations shown for each document: which repository and worktree it is in, and where.
// Everything is derived from the list of open documents; nothing touches the filesystem.

export const FORMAT_LABEL: Record<DocumentFormat, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  image: 'Image',
};

export const REPOSITORY_REASON: Record<RepositoryReason, string> = {
  'invalid-git-file': "This folder's .git file is not valid",
  'invalid-git-dir': "This folder's .git is not a valid Git directory",
  'link-mismatch': "This folder's .git does not match its repository",
  unreadable: "This folder's Git files cannot be read",
  'limit-exceeded': "This folder's Git files are too large to read",
  'blocked-path': "This folder's .git points to another computer",
};

// Bidirectional controls and other invisible format characters can make a name look like a different one.
// They are shown as their code point instead.
const INVISIBLE = /[؜​-‏‪-‮⁠-⁤⁦-⁯﻿]/gu;
export function visible(text: string): string {
  return text.replace(
    INVISIBLE,
    (character) =>
      `<U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

type Repository = NonNullable<DocumentSummary['repository']>;
type Resolved = Extract<Repository, { state: 'resolved' }>;
type Unresolved = Extract<Repository, { state: 'unresolved' }>;

// The group a document is placed in.
export type Placement =
  | { kind: 'repository'; key: string; repository: Resolved }
  | { kind: 'unresolved'; key: string; repository: Unresolved }
  | { kind: 'pending' }
  | { kind: 'outside' }
  | { kind: 'input' };

export function placementOf(document: DocumentSummary): Placement {
  if (document.sourceKind !== 'file') return { kind: 'input' };
  const repository = document.repository;
  if (repository === null) return { kind: 'outside' };
  if (repository.state === 'pending') return { kind: 'pending' };
  if (repository.state === 'unresolved') {
    return { kind: 'unresolved', key: `unresolved:${repository.id}`, repository };
  }
  return { kind: 'repository', key: `repository:${repository.id}`, repository };
}

// Splits a file name into the stem and the extension (".md"). A leading dot is part of the stem.
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
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

// The directories of a document: within its checkout, or the whole path outside a repository.
export function directoriesOf(document: DocumentSummary): string[] {
  const placement = placementOf(document);
  if (placement.kind === 'repository' || placement.kind === 'unresolved') {
    return placement.repository.pathInCheckout.slice(0, -1);
  }
  return document.pathSegments.slice(0, -1);
}

export function fileNameOf(document: DocumentSummary): string {
  const placement = placementOf(document);
  if (placement.kind === 'repository' || placement.kind === 'unresolved') {
    return placement.repository.pathInCheckout.at(-1) ?? document.title;
  }
  return document.pathSegments.at(-1) ?? document.title;
}

// Documents whose short paths are compared: the same checkout, the same unresolved folder, or the same group.
function scopeOf(document: DocumentSummary): string {
  const placement = placementOf(document);
  if (placement.kind === 'repository') {
    return `${placement.key}\0${placement.repository.checkout?.id ?? ''}`;
  }
  if (placement.kind === 'unresolved') return placement.key;
  return placement.kind;
}

export interface ShortDirectory {
  // How many of the last directories are shown. The rest are replaced with "…/".
  shown: string[];
  elided: boolean;
}

// Shows only the nearest directory, and more of them only where two documents with the same file name would look the same.
// Decided from the list, without measuring widths. Documents are split by their last directories one level at a time,
// so the work grows with the number of documents, not with its square (many README.md files are common).
export function shortDirectories(documents: DocumentSummary[]): Map<string, ShortDirectory> {
  const groups = new Map<string, Array<{ id: string; directories: string[] }>>();
  for (const document of documents) {
    if (document.sourceKind !== 'file') continue;
    const key = `${scopeOf(document)}\0${fileNameOf(document)}`;
    const entry = { id: document.documentId, directories: directoriesOf(document) };
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const result = new Map<string, ShortDirectory>();
  const settle = (entry: { id: string; directories: string[] }, length: number) => {
    const shown = Math.min(length, entry.directories.length);
    result.set(entry.id, {
      shown: entry.directories.slice(entry.directories.length - shown),
      elided: shown < entry.directories.length,
    });
  };
  for (const members of groups.values()) {
    let open = members;
    for (let length = 1; open.length > 0; length += 1) {
      const buckets = new Map<string, typeof open>();
      for (const entry of open) {
        const suffix = entry.directories.slice(-length).join('/');
        const bucket = buckets.get(suffix);
        if (bucket) bucket.push(entry);
        else buckets.set(suffix, [entry]);
      }
      const next: typeof open = [];
      for (const bucket of buckets.values()) {
        for (const entry of bucket) {
          // Unique at this depth, or nothing more to show: the path is complete.
          if (bucket.length === 1 || entry.directories.length <= length) settle(entry, length);
          else next.push(entry);
        }
      }
      open = next;
    }
  }
  return result;
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

// The whole location as one line of text: for the description read out and for the tooltip.
export function locationText(document: DocumentSummary, labels: Labels): string {
  const placement = placementOf(document);
  if (placement.kind === 'input') {
    return document.sourceKind === 'stdin' ? 'Standard input' : 'Generated';
  }
  const path = [...directoriesOf(document), fileNameOf(document)].join('/');
  if (placement.kind === 'outside') return document.canonicalPath ?? path;
  if (placement.kind === 'pending') {
    return `Checking repository… ${document.canonicalPath ?? path}`;
  }
  const name = labels.repository.get(placement.key) ?? '';
  if (placement.kind === 'unresolved') {
    return `${name} (${REPOSITORY_REASON[placement.repository.reason]}) · ${path}`;
  }
  const checkout = placement.repository.checkout;
  if (checkout?.kind === 'linked')
    return `${name} · worktree ${worktreeText(checkout, labels)} · ${path}`;
  if (checkout === null) return `${name} · unknown checkout · ${path}`;
  return `${name} · ${path}`;
}
