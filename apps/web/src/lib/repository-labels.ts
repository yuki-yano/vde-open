import type {
  DocumentFormat,
  DocumentSummary,
  MobileDocument,
  RepositoryReason,
} from '@vde-open/shared';
// Web code takes these from the subpath, not the package root: the root builds zod schemas on load, and zod's eval
// probe is a violation of the phone screen's CSP.
import { placementOf, worktreeText, type Labels } from '@vde-open/shared/repository-labels';

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

// Splits a file name into the stem and the extension (".md"). A leading dot is part of the stem.
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
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

// A document as a list shows it, on the PC or the phone: the group it goes in with the names to show, and its path
// as directories and a file name. The tree and the short paths are built from these on both screens.
export interface ListDocument {
  documentId: string;
  title: string;
  format: DocumentFormat;
}

export type ListCheckout =
  | { kind: 'main' }
  // Inside the .git directory, for example a removed worktree.
  | { kind: 'unknown' }
  // location: the folder, for the tooltip. null on the phone, which never gets paths.
  | { kind: 'linked'; key: string; label: string; location: string | null };

export type ListPlace =
  | { kind: 'input'; source: 'stdin' | 'generated' }
  | { kind: 'pending' }
  | { kind: 'outside' }
  | {
      kind: 'repository';
      key: string;
      name: string;
      location: string | null;
      checkout: ListCheckout;
    }
  | {
      kind: 'unresolved';
      key: string;
      name: string;
      location: string | null;
      reason: RepositoryReason;
    };

export interface ListEntry<D extends ListDocument = ListDocument> {
  document: D;
  place: ListPlace;
  // Within the checkout in a repository. Outside one: the whole path on the PC, none on the phone.
  directories: string[];
  fileName: string;
}

// The folder of a repository for the tooltip: its common Git directory without the trailing .git.
function folderOf(id: string): string {
  return id.replace(/[\\/]\.git$/, '');
}

export function pcEntry(document: DocumentSummary, labels: Labels): ListEntry<DocumentSummary> {
  const placement = placementOf(document);
  const entry = { document, directories: directoriesOf(document), fileName: fileNameOf(document) };
  switch (placement.kind) {
    case 'input':
      return {
        ...entry,
        place: { kind: 'input', source: document.sourceKind === 'stdin' ? 'stdin' : 'generated' },
      };
    case 'outside':
    case 'pending':
      return { ...entry, place: { kind: placement.kind } };
    case 'unresolved':
    case 'repository': {
      const { repository } = placement;
      const name = labels.repository.get(placement.key) ?? repository.nameSegments.at(-1) ?? '';
      const location = folderOf(repository.id);
      if (placement.kind === 'unresolved') {
        const reason = placement.repository.reason;
        return {
          ...entry,
          place: { kind: 'unresolved', key: placement.key, name, location, reason },
        };
      }
      const checkout = placement.repository.checkout;
      return {
        ...entry,
        place: {
          kind: 'repository',
          key: placement.key,
          name,
          location,
          checkout:
            checkout === null
              ? { kind: 'unknown' }
              : checkout.kind === 'main'
                ? { kind: 'main' }
                : {
                    kind: 'linked',
                    key: checkout.id,
                    label: labels.worktree.get(checkout.id) ?? checkout.name,
                    location: checkout.id,
                  },
        },
      };
    }
  }
}

// The phone's row already carries the names the PC shows. A document outside a repository has only its file name.
export function phoneEntry(row: MobileDocument): ListEntry<MobileDocument> {
  const { location } = row;
  switch (location.kind) {
    case 'stdin':
    case 'generated':
      return {
        document: row,
        place: { kind: 'input', source: location.kind },
        directories: [],
        fileName: row.title,
      };
    case 'outside':
    case 'pending':
      return {
        document: row,
        place: { kind: location.kind },
        directories: [],
        fileName: location.fileName,
      };
    case 'unresolved':
    case 'repository': {
      const path = {
        document: row,
        directories: location.path.slice(0, -1),
        fileName: location.path.at(-1) ?? row.title,
      };
      const { key, name } = location;
      if (location.kind === 'unresolved') {
        return {
          ...path,
          place: { kind: 'unresolved', key, name, location: null, reason: location.reason },
        };
      }
      const { checkout } = location;
      return {
        ...path,
        place: {
          kind: 'repository',
          key,
          name,
          location: null,
          checkout:
            checkout.kind === 'linked'
              ? { kind: 'linked', key: checkout.key, label: checkout.label, location: null }
              : checkout,
        },
      };
    }
  }
}

// Documents whose short paths are compared: the same checkout, the same unresolved folder, or the same group.
function scopeOf(place: ListPlace): string {
  if (place.kind === 'repository') {
    const checkout = place.checkout;
    return `${place.key}\0${checkout.kind === 'linked' ? `linked:${checkout.key}` : checkout.kind}`;
  }
  if (place.kind === 'unresolved') return place.key;
  return place.kind;
}

export interface ShortDirectory {
  // How many of the last directories are shown. The rest are replaced with "…/".
  shown: string[];
  elided: boolean;
}

// Shows only the nearest directory, and more of them only where two documents with the same file name would look the same.
// Decided from the list, without measuring widths. Documents are split by their last directories one level at a time,
// so the work grows with the number of documents, not with its square (many README.md files are common).
export function shortDirectories(entries: ListEntry[]): Map<string, ShortDirectory> {
  const groups = new Map<string, Array<{ id: string; directories: string[] }>>();
  for (const { document, place, directories, fileName } of entries) {
    if (place.kind === 'input') continue;
    const key = `${scopeOf(place)}\0${fileName}`;
    const entry = { id: document.documentId, directories };
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
