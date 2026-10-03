import type { HtmlMode, RenderGrantResult } from '@vde-open/shared';
import { useEffect, useRef, useState } from 'react';

import type { Api } from './api.ts';

export type GrantState =
  | { status: 'loading' }
  | { status: 'ready'; grant: RenderGrantResult }
  | { status: 'failed'; message: string };

interface Loaded {
  key: string;
  // The document's state-update time at the moment the fetch started.
  updatedAt: string;
  state: GrantState;
}

// A value that says which point in time the fetch is for. Only when this value changes is the same revision refetched.
//
// A document whose referenced files could not be scanned may finish scanning without a new revision (a document with no references).
// Only in that case, if the document's state was updated after the fetch, refetch to bring the view's notes up to date.
// The decision compares "the update time at fetch" with "the update time now".
// The fetched result itself is never a reason to refetch (that would loop: every fetch triggers another).
export function fetchTokenOf(
  loaded: Pick<Loaded, 'updatedAt' | 'state'> | null,
  updatedAt: string,
): string {
  if (loaded === null) return updatedAt;
  const scanFailed =
    loaded.state.status === 'ready' &&
    loaded.state.grant.diagnostics.some((diagnostic) => diagnostic.code === 'asset-scan-failed');
  return scanFailed ? updatedAt : loaded.updatedAt;
}

// Split the grants retired from the view into those that may be released now and those that may not yet.
// displayed is the grant of the view currently on screen. It is not released until it leaves the screen.
export function splitRetired(
  retired: readonly string[],
  displayed: string | null,
): { release: string[]; keep: string[] } {
  return {
    release: retired.filter((grant) => grant !== displayed),
    keep: retired.filter((grant) => grant === displayed),
  };
}

// Conditions for fetching a view. mode and requestId, like the revision, distinguish render grants.
export interface GrantOptions {
  mode: HtmlMode;
  // If showing a question awaiting an answer, that question. The daemon decides the revision and view mode from the question (mode is not used).
  requestId: string | null;
  // A value that changes when refetching under the same conditions as a new view (a new instance).
  nonce: number;
}

const STATIC_OPTIONS: GrantOptions = { mode: 'static', requestId: null, nonce: 0 };

// Fetch a render grant for each revision to show.
// updatedAt is the time the document's state was last updated (the value in the list summary).
//
// Grants are released only after the on-screen view has been replaced, and when the view is dismissed.
// The grant of the view on screen is never released first (spec 10.2).
// While refetching, and when the refetch fails, the grant in use stays in use.
export function useRenderGrant(
  api: Api,
  documentId: string,
  revision: string | null,
  updatedAt: string,
  options: GrantOptions = STATIC_OPTIONS,
): GrantState {
  const { mode, requestId, nonce } = options;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The grant in use for the view, and what it is for (document and revision).
  const held = useRef<{ key: string; grant: string } | null>(null);
  // Grants retired from the view. Released after the screen update has been applied.
  const retired = useRef<string[]>([]);
  const key = `${documentId}\n${revision ?? ''}\n${mode}\n${requestId ?? ''}\n${String(nonce)}`;
  const shown = loaded !== null && loaded.key === key ? loaded : null;
  const fetchToken = fetchTokenOf(shown, updatedAt);
  // The grant of the view this render puts on screen.
  const displayed = shown?.state.status === 'ready' ? shown.state.grant.grant : null;

  useEffect(() => {
    // Retire the grant in use from the view. It is released after the state update reaches the screen (the effect below).
    const retireHeld = () => {
      if (held.current !== null) retired.current.push(held.current.grant);
      held.current = null;
    };
    if (revision === null) {
      // No revision to show. At this point, the previous revision's view has left the screen.
      retireHeld();
      return undefined;
    }
    let cancelled = false;
    const issuing =
      requestId === null
        ? api.renderGrant(documentId, revision, { mode })
        : api.feedbackRenderGrant(requestId);
    void issuing.then(
      (grant) => {
        if (cancelled) {
          // No longer needed while waiting for the fetch. It was never used for the view, so release it right away.
          void api.releaseGrants([grant.grant]).catch(() => undefined);
          return;
        }
        // Switch the view to the new grant. The previous grant is released after the switch reaches the screen.
        retireHeld();
        held.current = { key, grant: grant.grant };
        setLoaded({ key, updatedAt: fetchToken, state: { status: 'ready', grant } });
      },
      (reason: unknown) => {
        if (cancelled) return;
        if (held.current?.key === key) {
          // Refetching the same revision failed. Keep the grant and content in use.
          // Record only that an attempt was made, and do not refetch until the document's state is next updated.
          setLoaded((current) =>
            current !== null && current.key === key
              ? { ...current, updatedAt: fetchToken }
              : current,
          );
          return;
        }
        // Could not switch to another revision's view. The previous revision's grant is no longer used.
        retireHeld();
        setLoaded({
          key,
          updatedAt: fetchToken,
          state: {
            status: 'failed',
            message: reason instanceof Error ? reason.message : 'Could not prepare the view.',
          },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, documentId, revision, mode, requestId, key, fetchToken]);

  // After every screen update, release the grants retired from the view.
  // An effect runs after the render it belongs to has reached the screen. It does not release the grant that render put on screen.
  // Between receiving a new grant and the render that uses it reaching the screen, the previous render's effect may run.
  // For that effect, the previous grant is still on screen, so it keeps it and leaves it to the next render's effect.
  useEffect(() => {
    const { release, keep } = splitRetired(retired.current, displayed);
    if (release.length === 0) return;
    retired.current = keep;
    void api.releaseGrants(release).catch(() => undefined);
  });

  // When the view is dismissed, release the grant in use and any grants not yet released.
  useEffect(
    () => () => {
      const grants = retired.current.splice(0);
      if (held.current !== null) grants.push(held.current.grant);
      held.current = null;
      if (grants.length > 0) void api.releaseGrants(grants).catch(() => undefined);
    },
    [api],
  );

  // A grant is tied only to the revision it was fetched for. Another revision's grant is not used.
  return shown?.state ?? { status: 'loading' };
}
