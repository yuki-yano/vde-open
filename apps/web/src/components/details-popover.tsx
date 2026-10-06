import { Popover } from '@base-ui/react/popover';
import { X } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

// Details stay next to their trigger without adding a row or moving the document.
export function DetailsPopover({
  trigger,
  title,
  children,
  enabled = true,
}: {
  trigger: ReactElement;
  title: string;
  children: ReactNode;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!enabled && open) setOpen(false);
  return (
    <Popover.Root open={enabled && open} onOpenChange={(next) => setOpen(enabled && next)}>
      <Popover.Trigger
        render={trigger}
        aria-haspopup={enabled ? 'dialog' : false}
        aria-expanded={enabled ? open : undefined}
      />
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="max-h-(--available-height) w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none">
            <div className="mb-2 flex items-center justify-between gap-3">
              <Popover.Title className="font-medium">{title}</Popover.Title>
              <Popover.Close
                render={<Button variant="ghost" size="icon-xs" aria-label="Close details" />}
              >
                <X aria-hidden="true" />
              </Popover.Close>
            </div>
            <div className="flex flex-col gap-3 break-words">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
