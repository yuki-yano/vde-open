import { Check, CircleAlert, Copy, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';

import { DetailsPopover } from '@/components/details-popover';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/lib/use-copy';

export function CopyButton({
  label,
  text,
  icon: Icon = Copy,
  title,
  code = false,
}: {
  label: string;
  text: string | ((button: HTMLButtonElement) => string);
  icon?: LucideIcon;
  title?: string;
  code?: boolean;
}) {
  const { result, copy, pending, dismiss } = useCopy();
  const lastText = useRef('');
  const failed = result?.ok === false;
  const ResultIcon = failed ? CircleAlert : result?.ok === true ? Check : Icon;
  return (
    <>
      <DetailsPopover
        enabled={failed}
        title="Copy failed"
        trigger={
          <Button
            variant={code ? 'outline' : 'ghost'}
            size={code ? 'xs' : 'icon-sm'}
            aria-label={`Copy ${label}`}
            title={failed ? `${result.message} Click for details.` : (title ?? `Copy ${label}`)}
            disabled={pending}
            className={failed ? 'text-destructive' : undefined}
            data-copy-state={failed ? 'failed' : result?.ok === true ? 'copied' : 'idle'}
            onClick={(event) => {
              if (!failed) {
                lastText.current = typeof text === 'string' ? text : text(event.currentTarget);
                void copy(label, lastText.current);
              }
            }}
          >
            <ResultIcon aria-hidden="true" />
            {code && 'Copy code'}
          </Button>
        }
      >
        <p>{result?.message}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void copy(label, lastText.current)}
          >
            Try again
          </Button>
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Dismiss
          </Button>
        </div>
      </DetailsPopover>
      <span role={failed ? 'alert' : 'status'} className="sr-only" data-testid="copy-result">
        {result?.message}
      </span>
    </>
  );
}
