import { useEffect, useState } from 'react';

import type { Api } from './api.ts';

// 表示の中から読み込もうとした、登録されていないfile（仕様10.3、13.4）。
// signal（daemonからの通知の回数）が変わるたびに取り直す。
export function useMissingAssets(api: Api, grant: string | null, signal: number): string[] {
  const [loaded, setLoaded] = useState<{
    grant: string;
    // 取得のきっかけになった通知の回数。
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
