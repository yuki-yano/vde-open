import type { FeedbackForAgent } from '@vde-open/shared';
import { useEffect, useMemo, useState } from 'react';

import type { Api } from './api.ts';
import { createRefresher } from './refresher.ts';

export interface PendingFeedback {
  // From the last fetch that succeeded.
  requests: FeedbackForAgent[];
  // Whether the last fetch failed.
  failed: boolean;
}

// Fetch the questions awaiting an answer whenever signal (the number of question-change notifications) changes.
// Fetches run one at a time, so a slow response never replaces the result of a later one.
export function usePendingFeedback(api: Api, signal: number): PendingFeedback {
  const [state, setState] = useState<PendingFeedback>({ requests: [], failed: false });
  const refresh = useMemo(
    () =>
      createRefresher(async () => {
        try {
          setState({ requests: await api.pendingFeedback(), failed: false });
        } catch (error) {
          setState((current) => ({ ...current, failed: true }));
          throw error;
        }
      }),
    [api],
  );
  useEffect(() => {
    void refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- signal is what triggers the refetch.
  }, [refresh, signal]);
  return state;
}
