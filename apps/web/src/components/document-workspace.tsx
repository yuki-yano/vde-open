import type { DocumentSummary } from '@vde-open/shared';
import { useState } from 'react';

import { FeedbackPanel } from '@/components/feedback-panel';
import { Viewer, type SectionTarget } from '@/components/viewer';
import type { Api } from '@/lib/api';
import { useFeedback } from '@/lib/use-feedback';

interface DocumentWorkspaceProps {
  api: Api;
  document: DocumentSummary;
  // 質問の変更の通知を受け取った回数。変わるたびに質問を取り直す。
  feedbackSignal: number;
  // 表示の中から登録されていないfileを読み込もうとした、という通知の回数。
  renderSignal: number;
  // 検索の結果から移動する先の節。
  sectionTarget?: SectionTarget | null;
}

// 文書の表示と、その文書への質問の回答panel。文書を切り替えたら作り直す（呼び出し側がkeyを渡す）。
export function DocumentWorkspace({
  api,
  document,
  feedbackSignal,
  renderSignal,
  sectionTarget = null,
}: DocumentWorkspaceProps) {
  const pendingId = document.pendingRequestIds[0] ?? null;
  // 回答を送信した後も、同じ文書を表示している間は、その質問の状態（送信済み・取得済み）を表示する。
  const [remembered, setRemembered] = useState<string | null>(pendingId);
  if (pendingId !== null && pendingId !== remembered) setRemembered(pendingId);
  const requestId = pendingId ?? remembered;
  const { request, error, reload } = useFeedback(api, requestId, feedbackSignal, document.revision);
  const fixedRevision = request?.status === 'pending' ? request.revision : null;
  // 回答待ちの質問があるなら、取得するまで文書を表示しない。表示する版と、HTMLから回答案を
  // 受け付けるかは、質問で決まる（取得できなかったときは、文書の現在の版を表示する）。
  const waitingForRequest = pendingId !== null && request === null && error === null;

  return (
    // 900px未満では、文書の表示と回答panelを縦に並べる。回答panelは表示の外に置き、HTMLが覆えない。
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
            aria-label="質問への回答"
            className="w-full shrink-0 border-t px-4 py-4 min-[900px]:w-96 min-[900px]:border-t-0 min-[900px]:border-l"
          >
            <p role="alert" className="text-sm text-destructive">
              質問を取得できませんでした（{error}）。
            </p>
          </aside>
        )
      )}
    </div>
  );
}
