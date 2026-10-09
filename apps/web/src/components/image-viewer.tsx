import type { DocumentSummary } from '@vde-open/shared';
import { Hash, Pause, Play, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DocumentLocation } from '@/components/document-location';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ViewerProps } from '@/components/viewer';
import { useRenderGrant } from '@/lib/use-render-grant';

type ImageResult = { url: string; failed: boolean };

export function ImageViewer({
  api,
  document,
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
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
      <div className="min-w-0 flex-1 basis-56">
        <h1 className="truncate text-base font-semibold">{document.title}</h1>
        <p
          className="text-xs [overflow-wrap:anywhere] text-muted-foreground"
          title={document.canonicalPath ?? undefined}
          data-testid="document-location"
        >
          <DocumentLocation document={document} />
          {revision && <span title={revision}> · Revision {revision.slice(4, 12)}</span>}
        </p>
      </div>
      {document.displayPath !== null && (
        <CopyButton label="document path" text={document.displayPath} />
      )}
      <CopyButton
        label="document ID"
        text={document.documentId}
        icon={Hash}
        title={`Copy document ID (${document.documentId})`}
      />
      <Badge variant="outline">Image</Badge>
      {fixedRevision !== null ? (
        <Badge variant="secondary">Showing the question's revision</Badge>
      ) : pinnedRevision !== null ? (
        <Badge variant="secondary">
          {pinnedRevision === document.revision ? 'Updates paused' : 'Update available'}
        </Badge>
      ) : null}
      <Button
        variant={actualSize ? 'secondary' : 'outline'}
        size="sm"
        aria-pressed={actualSize}
        onClick={onToggleSize}
        title="Switch between original dimensions and fitting the image to the view"
      >
        Actual size
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={pinnedRevision !== null}
        disabled={fixedRevision !== null}
        onClick={onTogglePause}
      >
        {pinnedRevision !== null ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        {pinnedRevision !== null ? 'Resume updates' : 'Pause updates'}
      </Button>
      <Button variant="ghost" size="sm" onClick={onRefresh}>
        <RefreshCw aria-hidden="true" />
        Refresh
      </Button>
    </header>
  );
}

function ImageCanvas({
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
    <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
      {sourceNotice}
    </p>
  );
}
