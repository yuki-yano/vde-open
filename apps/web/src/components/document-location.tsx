import type { DocumentSummary } from '@vde-open/shared';
import { CircleAlert, GitBranch } from 'lucide-react';
import { createContext, useContext } from 'react';

import {
  placementOf,
  REPOSITORY_REASON,
  visible,
  worktreeText,
  type Labels,
} from '@/lib/repository-labels';

// The names the list shows (same-named repositories told apart, worktree names added where branches meet).
// Provided by the workspace from the whole document list, so the header names a repository the way the list does.
export const RepositoryLabelsContext = createContext<Labels>({
  repository: new Map(),
  worktree: new Map(),
});

// Where the shown document is, in full: the repository, the worktree, and the path within it.
// The list shortens these; here they wrap instead, so the whole location can be read on touch devices too.
export function DocumentLocation({ document }: { document: DocumentSummary }) {
  const labels = useContext(RepositoryLabelsContext);
  const placement = placementOf(document);
  if (placement.kind === 'input') return <>{document.displayPath ?? '(opened from stdin)'}</>;
  const canonical = visible(document.canonicalPath ?? document.displayPath ?? '');
  if (placement.kind === 'outside') return <bdi>{canonical}</bdi>;
  if (placement.kind === 'pending') {
    return (
      <>
        Checking repository… · <bdi>{canonical}</bdi>
      </>
    );
  }
  const { repository } = placement;
  const name = visible(
    labels.repository.get(placement.key) ?? repository.nameSegments.at(-1) ?? '',
  );
  const path = visible(repository.pathInCheckout.join('/'));
  if (placement.kind === 'unresolved') {
    return (
      <>
        <CircleAlert className="mr-1 inline size-3 align-[-2px]" aria-hidden="true" />
        <bdi>{name}</bdi> ({REPOSITORY_REASON[placement.repository.reason]}) · <bdi>{path}</bdi>
      </>
    );
  }
  const checkout = placement.repository.checkout;
  return (
    <>
      <bdi className="font-medium">{name}</bdi>
      {checkout?.kind === 'linked' && (
        <>
          {' '}
          <GitBranch className="inline size-3 align-[-2px]" aria-hidden="true" />
          <span className="sr-only">worktree</span>{' '}
          {/* The worktree's own name is shown too when it differs from the branch, so a branch two worktrees share
              (or a stale one) can be told apart. */}
          <bdi>{visible(worktreeText(checkout, labels))}</bdi>
        </>
      )}
      {checkout === null && ' · unknown checkout'} · <bdi>{path}</bdi>
    </>
  );
}
