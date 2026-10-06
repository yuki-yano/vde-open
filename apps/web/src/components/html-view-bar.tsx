import { CircleAlert, Info } from 'lucide-react';

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
}: {
  mode: 'static' | 'interactive';
  bridge: BridgeStatus;
  needsPermission: boolean;
  pinnedStatic: boolean;
  modeError: string | null;
  onRunScripts: () => void;
  onStopScripts: () => void;
  onReload: () => void;
}) {
  const running = mode === 'interactive';
  const closed = bridge.status === 'closed';
  const connection = connectionLabel(bridge);
  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/50 px-3 py-1 text-[0.8rem]"
      data-testid="html-view-bar"
    >
      <span className="font-medium">Document content</span>
      <span className="text-muted-foreground" data-testid="html-mode">
        {running
          ? 'Scripts running'
          : pinnedStatic
            ? 'Scripts off for this question'
            : 'Scripts off'}
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
      <div className="ml-auto flex items-center gap-1">
        {closed && bridge.reason !== 'request-closed' && (
          <Button size="xs" variant="ghost" onClick={onReload}>
            Reload view
          </Button>
        )}
        <DetailsPopover
          title="Document view"
          trigger={
            <Button size="xs" variant="ghost">
              {closed || modeError ? (
                <CircleAlert aria-hidden="true" />
              ) : (
                <Info aria-hidden="true" />
              )}
              Details
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
        Links and form submission inside the view are disabled. Open links from “Links in this
        document”.
      </p>
      {running ? (
        <p>
          <ScriptLimits />
        </p>
      ) : (
        <p>Scripts do not run in this view.</p>
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
