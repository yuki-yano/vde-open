import { CircleAlert, GitBranch } from 'lucide-react';

import {
  FORMAT_LABEL,
  splitFileName,
  visible,
  type ListEntry,
  type ShortDirectory,
} from '@/lib/repository-labels';

// The second line of a flat row, on the PC and the phone: repository, worktree, then the path within the checkout.
// Only the nearest directory is shown (more where two documents would look the same).
// When the line is too narrow, the worktree name shrinks first, then the directory, then the file name.
// The repository name (up to 60% of the line) and the extension never shrink.
// Flex shares shrinking by weight, so the weights differ by orders of magnitude: a part shrinks
// by a negligible fraction (well under a pixel) until the parts before it are gone.
export function LocationLine({
  entry,
  short,
}: {
  entry: ListEntry;
  short: ShortDirectory | undefined;
}) {
  const { place } = entry;
  if (place.kind === 'input') {
    return (
      <span className="truncate">
        {place.source === 'stdin' ? 'Standard input' : 'Generated'} ·{' '}
        {FORMAT_LABEL[entry.document.format]}
      </span>
    );
  }
  const { stem, extension } = splitFileName(visible(entry.fileName));
  const directory =
    short === undefined || short.shown.length === 0
      ? ''
      : `${short.elided ? '…/' : ''}${short.shown.map(visible).join('/')}/`;
  const path = (
    <span className="flex min-w-0 shrink">
      {/* At least wide enough for the ellipsis, so a squeezed directory never shows a stray letter. */}
      {directory !== '' && <span className="min-w-3 shrink-[100000] truncate">{directory}</span>}
      <span className="min-w-0 shrink truncate">{stem}</span>
      <span className="shrink-0" data-part="extension">
        {extension}
      </span>
    </span>
  );
  if (place.kind === 'outside') return path;
  if (place.kind === 'pending') {
    return (
      <>
        <span className="shrink-0">Checking repository…</span>
        {path}
      </>
    );
  }
  const checkout = place.kind === 'repository' ? place.checkout : undefined;
  return (
    <>
      <span
        className="flex max-w-[50%] shrink-0 items-center gap-1 font-medium @min-[13rem]/list:max-w-[60%]"
        data-part="repository"
      >
        {place.kind === 'unresolved' && (
          <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
        )}
        <bdi className="min-w-0 truncate" data-part="repository-name">
          {visible(place.name)}
        </bdi>
      </span>
      {checkout?.kind === 'linked' && (
        // The branch icon stays whole even when the name has no room left.
        <span
          className="flex min-w-3 shrink-[100000] items-center gap-0.5 overflow-hidden"
          data-part="worktree"
        >
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <bdi className="min-w-0 truncate">{visible(checkout.label)}</bdi>
        </span>
      )}
      {checkout?.kind === 'unknown' && (
        <span className="min-w-0 shrink-[100000] truncate">(unknown checkout)</span>
      )}
      {path}
    </>
  );
}
