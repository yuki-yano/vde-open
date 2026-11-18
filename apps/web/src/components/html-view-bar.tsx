import { CircleAlert, Info, SquareDashed } from 'lucide-react';
import type { ReactNode } from 'react';

import { DetailsPopover } from '@/components/details-popover';
import { Button } from '@/components/ui/button';
import type { BridgeStatus } from '@/lib/use-bridge';

// Shared with the explicit permission dialog so the execution limits do not drift.
export function ScriptLimits() {
  return (
    <>
      Scripts can load only the files registered for this document and cannot reach this app, its
      management API, or unregistered files. Some outbound requests, including navigation inside the
      view, are not blocked.
    </>
  );
}

const CLOSED: Record<string, string> = {
  navigated: 'View reloaded',
  'request-closed': 'Question closed',
  expired: 'Render permission expired',
  replaced: 'Draft connection ended',
};

function connectionLabel(bridge: BridgeStatus): string | null {
  if (bridge.status === 'connected') return 'Drafts linked (not sent)';
  if (bridge.status === 'closed') return CLOSED[bridge.reason] ?? 'Invalid draft message';
  return null;
}

export function HtmlViewBar({
  mode,
  bridge,
  needsPermission,
  pinnedStatic,
  modeError,
  onRunScripts,
  onStopScripts,
  onReload,
  children,
}: {
  mode: 'static' | 'interactive';
  bridge: BridgeStatus;
  needsPermission: boolean;
  pinnedStatic: boolean;
  modeError: string | null;
  onRunScripts: () => void;
  onStopScripts: () => void;
  onReload: () => void;
  children: ReactNode;
}) {
  const running = mode === 'interactive';
  const closed = bridge.status === 'closed';
  const connection = connectionLabel(bridge);
  return (
    <div
      className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-0.5 border-b bg-chrome px-3 py-0.5 text-xs"
      data-testid="html-view-bar"
    >
      {/* Required: what the frame holds and whether its scripts run. Each part may move to its own line
          but is never cut; the optional parts and buttons wrap first. */}
      <span className="flex flex-wrap items-center gap-x-1.5 [&>*]:whitespace-nowrap">
        <SquareDashed className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">Document content</span>
        <span className="text-muted-foreground" data-testid="html-mode">
          {running
            ? 'Scripts running'
            : pinnedStatic
              ? 'Scripts off for this question'
              : 'Scripts off'}
        </span>
      </span>
      {needsPermission && <span className="text-destructive">Permission cleared</span>}
      {connection !== null && (
        <span
          role="status"
          className={closed ? 'text-destructive' : 'text-muted-foreground'}
          data-testid="bridge-status"
        >
          {connection}
        </span>
      )}
      {modeError && (
        <span role="alert" className="text-destructive">
          Script change failed
        </span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {closed && bridge.reason !== 'request-closed' && (
          <Button size="xs" variant="ghost" onClick={onReload}>
            Reload view
          </Button>
        )}
        {children}
        <DetailsPopover
          title="Document view"
          trigger={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Details"
              title="About this view"
              className={closed || modeError ? 'text-destructive' : undefined}
            >
              {closed || modeError ? (
                <CircleAlert aria-hidden="true" />
              ) : (
                <Info aria-hidden="true" />
              )}
            </Button>
          }
        >
          <HtmlViewDetails
            mode={mode}
            bridge={bridge}
            needsPermission={needsPermission}
            pinnedStatic={pinnedStatic}
            modeError={modeError}
            connection={connection}
          />
        </DetailsPopover>
        {running && (
          <Button size="xs" variant="ghost" onClick={onStopScripts}>
            Turn off scripts
          </Button>
        )}
        {needsPermission && (
          <Button size="xs" variant="outline" onClick={onRunScripts}>
            Run scripts…
          </Button>
        )}
      </div>
    </div>
  );
}

function HtmlViewDetails({
  mode,
  bridge,
  needsPermission,
  pinnedStatic,
  modeError,
  connection,
}: {
  mode: 'static' | 'interactive';
  bridge: BridgeStatus;
  needsPermission: boolean;
  pinnedStatic: boolean;
  modeError: string | null;
  connection: string | null;
}) {
  const running = mode === 'interactive';
  const closed = bridge.status === 'closed';
  return (
    <>
      <p>Buttons and text inside the view belong to the opened document, rather than this app.</p>
      <p>
        Links to local documents and headings work in the preview. Open external links from “Links
        in this document”. Forms are display-only.
      </p>
      {running ? (
        <p>
          <ScriptLimits />
        </p>
      ) : (
        <p>Scripts from the document are off in this view.</p>
      )}
      {pinnedStatic && (
        <p>
          This question was created in the Static view, so scripts stay off until it is answered.
        </p>
      )}
      {needsPermission && (
        <p>
          The permission to run scripts was cleared, for example by a daemon restart. Use “Run
          scripts…” to allow them again.
        </p>
      )}
      {bridge.status === 'connected' && (
        <p>
          The document can read and replace draft answers. It cannot submit them. Only “Send answers
          to the agent” in the answer panel submits answers.
        </p>
      )}
      {closed && (
        <p>
          Draft answers from this view are no longer accepted. {connection}.{' '}
          {bridge.reason === 'request-closed'
            ? 'Reloading cannot reopen the question.'
            : 'Reload the view to reconnect.'}
        </p>
      )}
      {closed && !CLOSED[bridge.reason] && (
        <p>
          The document sent a message that breaks the rules, such as a malformed or oversized
          message or too many messages.
        </p>
      )}
      {modeError && <p className="text-destructive">{modeError}</p>}
    </>
  );
}
