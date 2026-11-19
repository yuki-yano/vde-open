import { dirname } from 'node:path';

import {
  placementOf,
  worktreeText,
  type DocumentSummary,
  type Labels,
  type MobileLocation,
} from '@vde-open/shared';

// Where a document is, for the phone (ADR-0017): named as the PC list names it, field by field, so nothing of the
// summary's paths passes through. `opaque` turns a repository or checkout ID into a key that cannot be turned back.
export function mobileLocationOf(
  summary: DocumentSummary,
  labels: Labels,
  opaque: (value: string) => string,
): MobileLocation {
  // The PC's name tells same-named repositories apart by their parent folders, up to the whole path. The phone gets it
  // only when one parent is enough and the name is still not the whole path; otherwise the name and part of its key.
  const nameOf = (key: string, nameSegments: string[]) => {
    const label = labels.repository.get(key) ?? '';
    const parts = label.split('/').length;
    if (parts === 1 || (parts === 2 && nameSegments.length > 2)) return label;
    return `${nameSegments.at(-1) ?? ''} (${opaque(key).slice(0, 6)})`;
  };
  // Within a folder at the root of a disk ("/", a drive, or a network share), a path is the whole path: only the file
  // name goes then.
  const pathOf = (folder: string, within: string[]) =>
    dirname(folder) === folder ? within.slice(-1) : [...within];
  const placement = placementOf(summary);
  const fileName = summary.pathSegments.at(-1) ?? summary.title;
  switch (placement.kind) {
    case 'input':
      return { kind: summary.sourceKind === 'stdin' ? 'stdin' : 'generated' };
    case 'outside':
    case 'pending':
      return { kind: placement.kind, fileName };
    case 'unresolved':
      return {
        kind: 'unresolved',
        key: opaque(placement.key),
        name: nameOf(placement.key, placement.repository.nameSegments),
        reason: placement.repository.reason,
        path: pathOf(placement.repository.id, placement.repository.pathInCheckout),
      };
    case 'repository': {
      const checkout = placement.repository.checkout;
      return {
        kind: 'repository',
        key: opaque(placement.key),
        name: nameOf(placement.key, placement.repository.nameSegments),
        checkout:
          checkout === null
            ? { kind: 'unknown' }
            : checkout.kind === 'main'
              ? { kind: 'main' }
              : {
                  kind: 'linked',
                  key: opaque(`checkout:${checkout.id}`),
                  label: labels.worktree.get(checkout.id) ?? checkout.name,
                  full: worktreeText(checkout, labels),
                },
        // Without a checkout, the path is from the folder of the repository's Git directory.
        path: pathOf(
          checkout?.id ?? dirname(placement.repository.id),
          placement.repository.pathInCheckout,
        ),
      };
    }
  }
}
