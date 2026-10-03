import type { FeedbackForUi } from '@vde-open/shared';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from './api.ts';

export interface FeedbackState {
  request: FeedbackForUi | null;
  error: string | null;
  reload: () => void;
}

// Fetch the question. Refetch whenever signal (the number of question-change notifications) or the document revision changes.
export function useFeedback(
  api: Api,
  requestId: string | null,
  signal: number,
  documentRevision: string | null,
): FeedbackState {
  const [loaded, setLoaded] = useState<{
    requestId: string;
    // What triggered the fetch (notification count, document revision, reload request).
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
          error: reason instanceof Error ? reason.message : 'Could not fetch the question.',
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
