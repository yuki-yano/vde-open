import type { DocumentSummary } from '@vde-open/shared';
import { useState } from 'react';

import { FeedbackPanel } from '@/components/feedback-panel';
import { Viewer } from '@/components/viewer';
import type { Api } from '@/lib/api';
import { useFeedback } from '@/lib/use-feedback';

interface DocumentWorkspaceProps {
  api: Api;
  document: DocumentSummary;
  // 質問の変更の通知を受け取った回数。変わるたびに質問を取り直す。
  feedbackSignal: number;
}

// 文書の表示と、その文書への質問の回答panel。文書を切り替えたら作り直す（呼び出し側がkeyを渡す）。
export function DocumentWorkspace({ api, document, feedbackSignal }: DocumentWorkspaceProps) {
  const pendingId = document.pendingRequestIds[0] ?? null;
  // 回答を送信した後も、同じ文書を表示している間は、その質問の状態（送信済み・取得済み）を表示する。
  const [remembered, setRemembered] = useState<string | null>(pendingId);
  if (pendingId !== null && pendingId !== remembered) setRemembered(pendingId);
  const requestId = pendingId ?? remembered;
  const { request, error, reload } = useFeedback(api, requestId, feedbackSignal, document.revision);
  const fixedRevision = request?.status === 'pending' ? request.revision : null;

  return (
    <div className="flex min-w-0 flex-1">
      <Viewer api={api} document={document} fixedRevision={fixedRevision} />
      {request ? (
        <FeedbackPanel key={request.requestId} api={api} request={request} reload={reload} />
      ) : (
        error !== null &&
        requestId !== null && (
          <aside aria-label="質問への回答" className="w-96 shrink-0 border-l px-4 py-4">
            <p role="alert" className="text-sm text-destructive">
              質問を取得できませんでした（{error}）。
            </p>
          </aside>
        )
      )}
    </div>
  );
}
