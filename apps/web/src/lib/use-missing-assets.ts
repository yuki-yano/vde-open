import { useEffect, useState } from 'react';

import type { Api } from './api.ts';

// Unregistered files the view tried to load (spec 10.3, 13.4).
// Refetched whenever signal (the number of notifications from the daemon) changes.
export function useMissingAssets(api: Api, grant: string | null, signal: number): string[] {
  const [loaded, setLoaded] = useState<{
    grant: string;
    // The notification count that triggered the fetch.
    fetchedFor: number;
    missing: string[];
  } | null>(null);

  useEffect(() => {
    if (grant === null) return undefined;
    let cancelled = false;
    void api.renderMissing(grant).then(
      (missing) => {
        if (!cancelled) setLoaded({ grant, fetchedFor: signal, missing });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, grant, signal]);

  return loaded !== null && loaded.grant === grant ? loaded.missing : [];
}
