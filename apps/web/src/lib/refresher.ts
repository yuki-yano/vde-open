// 再取得を1つずつ行う。複数を並行させると、先に始めた遅い取得の結果が、
// 後から始めた取得の結果を上書きして、古い一覧へ戻ることがある。
// 実行中に依頼が来たら、終わった後にもう一度だけ取得する。
// 戻り値は、依頼より後に始まった取得まで終わったときに解決する。
export function createRefresher(run: () => Promise<void>): () => Promise<void> {
  let requested = false;
  let loop: Promise<void> | null = null;

  // 依頼がある間、1件ずつ取得を続ける。取得の切り替わりで「実行中でない」瞬間を作らない。
  const drain = async (): Promise<void> => {
    while (requested) {
      requested = false;
      try {
        await run();
      } catch {
        // 取得の失敗は呼び出し側へ伝えない。次の依頼で取り直す。
      }
    }
    loop = null;
  };

  return () => {
    requested = true;
    loop ??= drain();
    return loop;
  };
}
