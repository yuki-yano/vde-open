import type { FeedbackForUi } from '@vde-open/shared';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from './api.ts';

export interface FeedbackState {
  request: FeedbackForUi | null;
  error: string | null;
  reload: () => void;
}

// 質問を取得する。signal（質問の変更の通知の回数）と、文書の版が変わるたびに取り直す。
export function useFeedback(
  api: Api,
  requestId: string | null,
  signal: number,
  documentRevision: string | null,
): FeedbackState {
  const [loaded, setLoaded] = useState<{
    requestId: string;
    // 取得のきっかけ（通知の回数・文書の版・取り直しの指示）。
    fetchedFor: string;
    request: FeedbackForUi | null;
    error: string | null;
  } | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const trigger = `${String(signal)}\n${documentRevision ?? ''}\n${String(nonce)}`;

  useEffect(() => {
    if (requestId === null) return undefined;
    let cancelled = false;
    void api.feedback(requestId).then(
      (request) => {
        if (!cancelled) setLoaded({ requestId, fetchedFor: trigger, request, error: null });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setLoaded((current) => ({
          requestId,
          fetchedFor: trigger,
          request: current?.requestId === requestId ? current.request : null,
          error: reason instanceof Error ? reason.message : '質問を取得できませんでした。',
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, requestId, trigger]);

  const shown = loaded !== null && loaded.requestId === requestId ? loaded : null;
  return { request: shown?.request ?? null, error: shown?.error ?? null, reload };
}
