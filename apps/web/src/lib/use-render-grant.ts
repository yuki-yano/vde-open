import type { RenderGrantResult } from '@vde-open/shared';
import { useEffect, useRef, useState } from 'react';

import type { Api } from './api.ts';

export type GrantState =
  | { status: 'loading' }
  | { status: 'ready'; grant: RenderGrantResult }
  | { status: 'failed'; message: string };

interface Loaded {
  key: string;
  // 取得を始めた時点の、文書の状態の更新時刻。
  updatedAt: string;
  state: GrantState;
}

// どの時点の状態に対して取得するか、を表す値。この値が変わったときだけ、同じ版を取り直す。
//
// 文書が参照するfileを調べられなかった文書は、版が同じまま調べ終えることがある（参照のない文書）。
// その場合だけ、取得した後に文書の状態が更新されていたら、取り直して表示の注意書きを最新にする。
// 判定は「取得した時点の更新時刻」と「いま届いている更新時刻」の比較で行う。
// 取得した結果そのものは、取り直しの理由にしない（取得するたびに取り直す、という循環を作らない）。
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

// 表示から外した権限を、いま返してよいものと、まだ返せないものに分ける。
// displayedは、いま画面に出している表示の権限。これは、画面から外れるまで返さない。
export function splitRetired(
  retired: readonly string[],
  displayed: string | null,
): { release: string[]; keep: string[] } {
  return {
    release: retired.filter((grant) => grant !== displayed),
    keep: retired.filter((grant) => grant === displayed),
  };
}

// 表示する版ごとに、表示用の権限を取得する。
// updatedAtは、文書の状態が最後に更新された時刻（一覧のsummaryの値）。
//
// 権限を返すのは、画面の表示を差し替え終えた後と、表示をやめたときだけ。
// 画面に出ている表示の権限を、先に返すことはしない（仕様10.2）。
// 取り直しの間と、取り直しに失敗したときは、表示中の権限をそのまま使う。
export function useRenderGrant(
  api: Api,
  documentId: string,
  revision: string | null,
  updatedAt: string,
): GrantState {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // 表示に使っている権限と、その権限の対象（文書と版）。
  const held = useRef<{ key: string; grant: string } | null>(null);
  // 表示から外すことにした権限。画面の差し替えが反映された後に返す。
  const retired = useRef<string[]>([]);
  const key = `${documentId}\n${revision ?? ''}`;
  const shown = loaded !== null && loaded.key === key ? loaded : null;
  const fetchToken = fetchTokenOf(shown, updatedAt);
  // この描画で画面に出す表示の権限。
  const displayed = shown?.state.status === 'ready' ? shown.state.grant.grant : null;

  useEffect(() => {
    // 表示中の権限を、表示から外す。返すのは、stateの更新が画面へ反映された後（下のeffect）。
    const retireHeld = () => {
      if (held.current !== null) retired.current.push(held.current.grant);
      held.current = null;
    };
    if (revision === null) {
      // 表示する版がない。この時点で、前の版の表示は画面から外れている。
      retireHeld();
      return undefined;
    }
    let cancelled = false;
    void api.renderGrant(documentId, revision).then(
      (grant) => {
        if (cancelled) {
          // 取得を待っている間に不要になった。表示には使っていないので、そのまま返す。
          void api.releaseGrants([grant.grant]).catch(() => undefined);
          return;
        }
        // 表示を新しい権限へ差し替える。前の権限は、差し替えが画面へ反映されてから返す。
        retireHeld();
        held.current = { key, grant: grant.grant };
        setLoaded({ key, updatedAt: fetchToken, state: { status: 'ready', grant } });
      },
      (reason: unknown) => {
        if (cancelled) return;
        if (held.current?.key === key) {
          // 同じ版の取り直しに失敗した。表示中の権限と内容を保つ。
          // 取得を試みた時点だけを記録し、次に文書の状態が更新されるまで、取り直さない。
          setLoaded((current) =>
            current !== null && current.key === key
              ? { ...current, updatedAt: fetchToken }
              : current,
          );
          return;
        }
        // 別の版の表示へ切り替えられなかった。前の版の権限は、もう使わない。
        retireHeld();
        setLoaded({
          key,
          updatedAt: fetchToken,
          state: {
            status: 'failed',
            message: reason instanceof Error ? reason.message : '表示を準備できませんでした。',
          },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, documentId, revision, key, fetchToken]);

  // 画面の更新のたびに、その後で、表示から外した権限を返す。
  // effectは、自分が属する描画が画面へ反映された後に動く。その描画で画面に出している権限は返さない。
  // 新しい権限を受け取ってから、それを使う描画が反映されるまでの間に、前の描画のeffectが動くことがある。
  // そのeffectにとっては、前の権限がまだ画面に出ているので、返さずに残し、次の描画のeffectに任せる。
  useEffect(() => {
    const { release, keep } = splitRetired(retired.current, displayed);
    if (release.length === 0) return;
    retired.current = keep;
    void api.releaseGrants(release).catch(() => undefined);
  });

  // 表示をやめるときに、使っていた権限と、まだ返していない権限を返す。
  useEffect(
    () => () => {
      const grants = retired.current.splice(0);
      if (held.current !== null) grants.push(held.current.grant);
      held.current = null;
      if (grants.length > 0) void api.releaseGrants(grants).catch(() => undefined);
    },
    [api],
  );

  // 権限は、取得した版にだけ結び付ける。別の版の権限は使わない。
  return shown?.state ?? { status: 'loading' };
}
