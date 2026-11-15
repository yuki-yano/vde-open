import type { FeedbackForAgent } from '@vde-open/shared';
import { useEffect, useMemo, useState } from 'react';

import type { Api } from './api.ts';
import { createRefresher } from './refresher.ts';

// The questions that wait on someone: the person's answer, or the agent picking up a submitted answer.
export interface FeedbackInbox {
  // Questions awaiting an answer, from the last fetch that succeeded.
  waiting: FeedbackForAgent[];
  // Submitted answers the agent has not acknowledged yet, from the same fetch.
  unacknowledged: FeedbackForAgent[];
  // Whether the last fetch failed.
  failed: boolean;
}

// Fetch both lists whenever signal (the number of question-change notifications) changes.
// Fetches run one at a time, so a slow response never replaces the result of a later one. Both lists are replaced
// together; a change that lands between the two requests is corrected by the refetch its notification triggers.
export function useFeedbackInbox(api: Api, signal: number): FeedbackInbox {
  const [state, setState] = useState<FeedbackInbox>({
    waiting: [],
    unacknowledged: [],
    failed: false,
  });
  const refresh = useMemo(
    () =>
      createRefresher(async () => {
        try {
          const [waiting, unacknowledged] = await Promise.all([
            api.pendingFeedback(),
            api.unacknowledgedFeedback(),
          ]);
          setState({ waiting, unacknowledged, failed: false });
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
