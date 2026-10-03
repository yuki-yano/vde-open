import type { DocumentSummary } from '@vde-open/shared';
import { useState } from 'react';

import { FeedbackPanel } from '@/components/feedback-panel';
import { Viewer, type SectionTarget } from '@/components/viewer';
import type { Api } from '@/lib/api';
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
}

// The document view plus the answer panel for the question on that document. Recreated when the document changes (the caller passes a key).
export function DocumentWorkspace({
  api,
  document,
  feedbackSignal,
  renderSignal,
  sectionTarget = null,
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

  return (
    // Below 900px, stack the document view and the answer panel vertically. The panel sits outside the view, so the HTML cannot cover it.
    <div className="flex min-w-0 flex-1 flex-col min-[900px]:flex-row">
      <Viewer
        api={api}
        document={document}
        fixedRevision={fixedRevision}
        request={request}
        renderSignal={renderSignal}
        waitingForRequest={waitingForRequest}
        sectionTarget={sectionTarget}
      />
      {request ? (
        <FeedbackPanel key={request.requestId} api={api} request={request} reload={reload} />
      ) : (
        error !== null &&
        requestId !== null && (
          <aside
            aria-label="Answer the question"
            className="w-full shrink-0 border-t px-4 py-4 min-[900px]:w-96 min-[900px]:border-t-0 min-[900px]:border-l"
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
