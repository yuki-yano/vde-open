import type { DocumentSummary } from '@vde-open/shared';
import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { FeedbackPanel } from '@/components/feedback-panel';
import { PaneResizeHandle } from '@/components/pane-resize-handle';
import { Viewer, type SectionTarget } from '@/components/viewer';
import type { Api } from '@/lib/api';
import type { HeadingInUrl, HeadingRestore } from '@/lib/location';
import { usePreference } from '@/lib/preferences';
import { useFeedback } from '@/lib/use-feedback';

interface DocumentWorkspaceProps {
  api: Api;
  document: DocumentSummary;
  // How many question-change notifications have been received. Refetch the question each time it changes.
  feedbackSignal: number;
  // How many times the view tried to load an unregistered file.
  renderSignal: number;
  // The section to jump to from a search result.
  sectionTarget?: SectionTarget | null;
  // The heading the URL keeps for this document, to jump to again once the view is ready.
  restoreHeading?: HeadingRestore | null;
  // Called with the heading the view jumped to (null: the heading in the URL is not in the document any more).
  onHeadingShown?: (heading: HeadingInUrl | null) => void;
  // Only the workspace on screen accepts draft answers from HTML.
  displayed?: boolean;
  // Called once the requested content can replace the document on screen.
  onReady?: () => void;
}

// Keep the reading surface in place until the next document is ready. Only two workspaces are mounted:
// the one on screen and the latest selection. A further selection discards the unfinished workspace.
export function DocumentSwitcher({
  documents,
  ...props
}: DocumentWorkspaceProps & { documents: DocumentSummary[] }) {
  const [shownId, setShownId] = useState(props.document.documentId);
  const shown = documents.find((document) => document.documentId === shownId);
  const switching = shown !== undefined && shown.documentId !== props.document.documentId;
  const workspaces = switching ? [shown, props.document] : [props.document];
  const ready = useCallback(
    () => setShownId(props.document.documentId),
    [props.document.documentId],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" aria-busy={switching}>
      {workspaces.map((document) => {
        const selected = document.documentId === props.document.documentId;
        const displayed = !switching || !selected;
        return (
          <div
            key={document.documentId}
            className={
              displayed
                ? 'flex min-h-0 min-w-0 flex-1'
                : 'invisible absolute inset-0 flex min-h-0 min-w-0'
            }
            aria-hidden={!displayed}
            inert={switching}
            data-testid="document-workspace"
          >
            <DocumentWorkspace
              {...props}
              document={document}
              displayed={displayed}
              onReady={selected ? ready : undefined}
              sectionTarget={selected && displayed ? props.sectionTarget : null}
              restoreHeading={selected && displayed ? props.restoreHeading : null}
              onHeadingShown={selected && displayed ? props.onHeadingShown : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

const ANSWER_MIN = 280;
const ANSWER_MAX = 640;
const ANSWER_DEFAULT = 360;
// The document keeps at least this width beside the answer panel; the panel narrows first.
const DOCUMENT_MIN = 320;
const HANDLE = 8;
const isAnswerWidth = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= ANSWER_MIN &&
  value <= ANSWER_MAX;

// The document view plus the answer panel for the question on that document. Recreated when the document changes (the caller passes a key).
export function DocumentWorkspace({
  api,
  document,
  feedbackSignal,
  renderSignal,
  sectionTarget = null,
  restoreHeading = null,
  onHeadingShown,
  displayed = true,
  onReady,
}: DocumentWorkspaceProps) {
  const pendingId = document.pendingRequestIds[0] ?? null;
  // After submitting, keep showing the question's state (submitted, retrieved) while the same document stays open.
  const [remembered, setRemembered] = useState<string | null>(pendingId);
  if (pendingId !== null && pendingId !== remembered) setRemembered(pendingId);
  const requestId = pendingId ?? remembered;
  const { request, error, reload } = useFeedback(api, requestId, feedbackSignal, document.revision);
  const fixedRevision = request?.status === 'pending' ? request.revision : null;
  // If a question is awaiting an answer, do not show the document until it is fetched. The question decides which revision
  // to show and whether to accept draft answers from the HTML (if it cannot be fetched, show the document's current revision).
  const waitingForRequest = pendingId !== null && request === null && error === null;
  const [preferredWidth, setAnswerWidth] = usePreference<number>(
    'answer-width',
    ANSWER_DEFAULT,
    isAnswerWidth,
  );
  const panelId = useId();
  const row = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return undefined;
    const measure = () => setRowWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const maxWidth = Math.max(ANSWER_MIN, Math.min(ANSWER_MAX, rowWidth - HANDLE - DOCUMENT_MIN));
  const width = Math.min(preferredWidth, maxWidth);

  return (
    // Below 900px, stack the document view and the answer panel vertically. The panel sits outside the view, so the HTML cannot cover it.
    <div
      ref={row}
      className="flex min-w-0 flex-1 flex-col min-[900px]:flex-row"
      style={{ '--answer-width': `${String(width)}px` } as CSSProperties}
    >
      <Viewer
        api={api}
        document={document}
        fixedRevision={fixedRevision}
        request={request}
        renderSignal={renderSignal}
        waitingForRequest={waitingForRequest}
        sectionTarget={sectionTarget}
        restoreHeading={restoreHeading}
        displayed={displayed}
        {...(onReady ? { onReady } : {})}
        {...(onHeadingShown ? { onHeadingShown } : {})}
      />
      {request ? (
        <>
          <PaneResizeHandle
            label="Resize answer panel"
            controls={panelId}
            width={width}
            min={ANSWER_MIN}
            max={maxWidth}
            onResize={(next) =>
              setAnswerWidth(Math.round(Math.min(maxWidth, Math.max(ANSWER_MIN, next))))
            }
            className="hidden min-[900px]:block"
          />
          <FeedbackPanel
            key={request.requestId}
            id={panelId}
            api={api}
            request={request}
            reload={reload}
          />
        </>
      ) : (
        error !== null &&
        requestId !== null && (
          <aside
            aria-label="Answer the question"
            className="w-full shrink-0 border-t px-3 py-3 min-[900px]:w-(--answer-width) min-[900px]:border-t-0 min-[900px]:border-l"
          >
            <p role="alert" className="text-sm text-destructive">
              Could not fetch the question ({error}).
            </p>
          </aside>
        )
      )}
    </div>
  );
}
