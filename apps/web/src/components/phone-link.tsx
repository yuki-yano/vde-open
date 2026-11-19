import { Smartphone } from 'lucide-react';
import { createContext, useContext } from 'react';
import { encode } from 'uqr';

import { CopyButton } from '@/components/copy-button';
import { DetailsPopover } from '@/components/details-popover';
import { Button } from '@/components/ui/button';

// The phone reader's bookmark URL from the daemon status, or null while it is not ready.
export const PhoneUrlContext = createContext<string | null>(null);

// The phone reader opens the document named by this parameter (mobile-reader.tsx).
export function phoneUrlOf(phoneUrl: string, documentId: string): string {
  const url = new URL(phoneUrl);
  url.searchParams.set('document', documentId);
  return url.href;
}

function QrCode({ text }: { text: string }) {
  const { size, data } = encode(text, { border: 2 });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${String(x)} ${String(y)}h1v1h-1z`;
    }),
  );
  return (
    // Dark on white whatever the theme, as cameras expect.
    <svg viewBox={`0 0 ${String(size)} ${String(size)}`} className="size-48 bg-white" role="img">
      <title>{`QR code for ${text}`}</title>
      <path d={path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}

// Shows the document's URL on the phone reader as a QR code. Hidden while the phone reader is not ready.
export function PhoneLinkButton({ documentId }: { documentId: string }) {
  const phoneUrl = useContext(PhoneUrlContext);
  if (phoneUrl === null) return null;
  const url = phoneUrlOf(phoneUrl, documentId);
  return (
    <DetailsPopover
      title="Open on your phone"
      className="w-auto"
      trigger={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open on your phone"
          title="Open on your phone"
        >
          <Smartphone aria-hidden="true" />
        </Button>
      }
    >
      <QrCode text={url} />
      <div className="flex max-w-48 items-start gap-1">
        <p className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground">{url}</p>
        <CopyButton label="phone URL" text={url} />
      </div>
      <p className="max-w-48 text-xs text-muted-foreground">
        Opens on a phone signed in to Tailscale with the same login.
      </p>
    </DetailsPopover>
  );
}
