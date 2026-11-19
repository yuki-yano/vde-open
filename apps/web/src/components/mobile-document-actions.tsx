import type { MobileDocument, SourceState } from '@vde-open/shared';
import { Info, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { FORMAT_LABEL, REPOSITORY_REASON, visible } from '@/lib/repository-labels';

// What a long press on a phone row offers. Removing needs no further confirmation, as the PC's close button needs none.

type FinalFocus = () => HTMLElement | boolean;

export function DocumentActions({
  document,
  open,
  onClose,
  onDetails,
  onRemove,
  finalFocus,
}: {
  document: MobileDocument | null;
  open: boolean;
  onClose: () => void;
  onDetails: () => void;
  onRemove: () => void;
  finalFocus: FinalFocus;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        finalFocus={finalFocus}
        // A sheet along the bottom edge, clear of the home indicator.
        className="top-auto bottom-0 left-0 max-w-none translate-x-0 translate-y-0 gap-2 rounded-b-none pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-none data-open:zoom-in-100 data-open:slide-in-from-bottom-4 data-closed:zoom-out-100 data-closed:slide-out-to-bottom-4"
      >
        <DialogTitle className="truncate px-1 pb-1">{document?.title}</DialogTitle>
        <Button variant="outline" size="lg" className="justify-start" onClick={onDetails}>
          <Info aria-hidden="true" />
          Details
        </Button>
        <Button variant="destructive" size="lg" className="justify-start" onClick={onRemove}>
          <X aria-hidden="true" />
          Remove from the PC list
        </Button>
        <DialogClose render={<Button variant="ghost" size="lg" />}>Cancel</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

const SOURCE_STATE: Record<SourceState, string> = {
  ready: 'Ready',
  missing: 'File missing',
  unreadable: 'Unreadable',
  updating: 'Updating',
  error: 'Error',
};

const when = (iso: string) => new Date(iso).toLocaleString();

// Where the document is, as the PC names it. Never an absolute path: outside a repository only the file name.
function locationRows(location: MobileDocument['location']): Array<[string, string]> {
  switch (location.kind) {
    case 'stdin':
      return [['Source', 'Standard input']];
    case 'generated':
      return [['Source', 'Generated']];
    case 'outside':
      return [
        ['Repository', 'Outside a repository'],
        ['File', location.fileName],
      ];
    case 'pending':
      return [
        ['Repository', 'Checking…'],
        ['File', location.fileName],
      ];
    case 'unresolved':
      return [
        ['Repository', `${location.name} (${REPOSITORY_REASON[location.reason]})`],
        ['Path', location.path.join('/')],
      ];
    case 'repository': {
      const { checkout } = location;
      return [
        ['Repository', location.name],
        ...(checkout.kind === 'linked'
          ? [['Worktree', checkout.full] as [string, string]]
          : checkout.kind === 'unknown'
            ? [['Worktree', 'Unknown checkout'] as [string, string]]
            : []),
        ['Path', location.path.join('/')],
      ];
    }
  }
}

export function DocumentDetails({
  document,
  open,
  onClose,
  finalFocus,
}: {
  document: MobileDocument | null;
  open: boolean;
  onClose: () => void;
  finalFocus: FinalFocus;
}) {
  const rows: Array<[string, string]> =
    document === null
      ? []
      : [
          ['Format', FORMAT_LABEL[document.format]],
          ...locationRows(document.location),
          ['Opened', when(document.openedAt)],
          ['Last updated', when(document.updatedAt)],
          ['File state', SOURCE_STATE[document.sourceState]],
          ...(document.effectiveMode === null
            ? []
            : [
                [
                  'HTML view',
                  document.effectiveMode === 'interactive'
                    ? 'Interactive (scripts run)'
                    : 'Static (scripts off)',
                ] as [string, string],
              ]),
        ];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent finalFocus={finalFocus} className="max-h-[85svh] overflow-y-auto">
        <DialogTitle className="pr-8 leading-snug [overflow-wrap:anywhere]">
          {document?.title}
        </DialogTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                <bdi>{visible(value)}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
