import type { DocumentSummary } from '@vde-open/shared';
import { Pause, Play, RefreshCw, Scan } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { DocumentHeader, ToolbarDivider } from '@/components/document-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ViewerProps } from '@/components/viewer';
import { useRenderGrant } from '@/lib/use-render-grant';

type ImageResult = { url: string; failed: boolean };

export function ImageViewer({
  api,
  document,
  daemonId = null,
  fixedRevision = null,
  request = null,
  waitingForRequest = false,
  restoreHeading = null,
  onHeadingShown,
  onReady,
}: ViewerProps) {
  const [pinnedRevision, setPinnedRevision] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [result, setResult] = useState<ImageResult | null>(null);
  const revision = waitingForRequest
    ? null
    : (fixedRevision ?? pinnedRevision ?? document.revision);
  const grant = useRenderGrant(api, document.documentId, revision, document.updatedAt, {
    mode: 'static',
    requestId: fixedRevision !== null && request?.status === 'pending' ? request.requestId : null,
    nonce: 0,
    daemonId,
  });
  const url = grant.status === 'ready' ? grant.grant.documentUrl : null;
  const settled = result !== null && result.url === url;
  const ready =
    !waitingForRequest &&
    (revision === null || grant.status === 'failed' || (url !== null && settled));
  const readyRef = useCallback(
    (element: HTMLElement | null) => {
      if (element !== null && ready) onReady?.();
    },
    [ready, onReady],
  );
  // Image documents have no headings to restore from the URL.
  useEffect(() => {
    if (restoreHeading !== null) onHeadingShown?.(null);
  }, [restoreHeading, onHeadingShown]);

  return (
    <section
      ref={readyRef}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Document view"
    >
      <ImageHeader
        document={document}
        revision={revision}
        fixedRevision={fixedRevision}
        pinnedRevision={pinnedRevision}
        actualSize={actualSize}
        onToggleSize={() => setActualSize((current) => !current)}
        onTogglePause={() => setPinnedRevision(pinnedRevision === null ? document.revision : null)}
        onRefresh={() => void api.refresh(document.documentId).catch(() => undefined)}
      />
      <ImageSourceNotice state={document.sourceState} />
      <ImageCanvas
        url={url}
        title={document.title}
        actualSize={actualSize}
        result={result}
        failure={grant.status === 'failed' ? grant.message : null}
        onResult={setResult}
      />
    </section>
  );
}

function ImageHeader({
  document,
  revision,
  fixedRevision,
  pinnedRevision,
  actualSize,
  onToggleSize,
  onTogglePause,
  onRefresh,
}: {
  document: DocumentSummary;
  revision: string | null;
  fixedRevision: string | null;
  pinnedRevision: string | null;
  actualSize: boolean;
  onToggleSize: () => void;
  onTogglePause: () => void;
  onRefresh: () => void;
}) {
  const paused = pinnedRevision !== null;
  return (
    <DocumentHeader document={document}>
      {fixedRevision !== null ? (
        <Badge
          variant="secondary"
          title={`Showing revision ${revision?.slice(4, 12) ?? ''}, which the question is about`}
        >
          Question's revision
        </Badge>
      ) : paused ? (
        <Badge variant="secondary">
          {pinnedRevision === document.revision ? 'Updates paused' : 'Update available'}
        </Badge>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        className="aria-pressed:bg-muted aria-pressed:text-foreground"
        aria-pressed={actualSize}
        aria-label="Actual size"
        title={actualSize ? 'Fit the image to the view' : 'Show the image at its original size'}
        onClick={onToggleSize}
      >
        <Scan aria-hidden="true" />
      </Button>
      <ToolbarDivider />
      <Button
        variant="ghost"
        size="icon-sm"
        className="aria-pressed:bg-muted aria-pressed:text-foreground"
        aria-pressed={paused}
        aria-label={paused ? 'Resume updates' : 'Pause updates'}
        title={paused ? 'Resume updates' : 'Pause updates (keep showing this revision)'}
        disabled={fixedRevision !== null}
        onClick={onTogglePause}
      >
        {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh"
        title="Read the file again"
        onClick={onRefresh}
      >
        <RefreshCw aria-hidden="true" />
      </Button>
    </DocumentHeader>
  );
}

// The image itself: fit or actual size, a load and decode failure message. Shared with the phone reader.
export function ImageCanvas({
  url,
  title,
  actualSize,
  result,
  failure,
  onResult,
}: {
  url: string | null;
  title: string;
  actualSize: boolean;
  result: ImageResult | null;
  failure: string | null;
  onResult: (result: ImageResult) => void;
}) {
  const settled = result !== null && result.url === url;
  const imageFailed = settled && result.failed;
  const error =
    failure ??
    (imageFailed
      ? 'This browser could not display the image. The format may be unsupported or the file may be damaged.'
      : null);
  return (
    <div
      className={`grid min-h-0 min-w-0 flex-1 overflow-auto p-4 ${actualSize ? '' : 'grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]'}`}
      data-testid="image-viewport"
    >
      {url !== null && (
        <img
          key={url}
          src={url}
          alt={title}
          referrerPolicy="no-referrer"
          className={
            actualSize
              ? 'col-start-1 row-start-1 block max-w-none'
              : 'col-start-1 row-start-1 m-auto block min-h-0 min-w-0 max-h-full max-w-full object-contain'
          }
          data-testid="document-image"
          hidden={imageFailed}
          onLoad={() => onResult({ url, failed: false })}
          onError={() => onResult({ url, failed: true })}
        />
      )}
      {error !== null ? (
        <p role="alert" className="col-start-1 row-start-1 m-auto text-sm text-destructive">
          {error}
        </p>
      ) : !settled ? (
        <p role="status" className="col-start-1 row-start-1 m-auto text-sm text-muted-foreground">
          Loading image…
        </p>
      ) : null}
    </div>
  );
}

function ImageSourceNotice({ state }: { state: DocumentSummary['sourceState'] }) {
  const sourceNotice =
    state === 'missing'
      ? 'The file is missing. Showing the last saved image.'
      : state === 'unreadable' || state === 'error'
        ? 'The file could not be read. Showing the last saved image.'
        : null;
  if (sourceNotice === null) return null;
  return (
    <p role="status" className="border-b px-3 py-1 text-xs text-muted-foreground">
      {sourceNotice}
    </p>
  );
}
