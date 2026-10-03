import { useCallback, useEffect, useRef, useState } from 'react';

export interface CopyResult {
  ok: boolean;
  message: string;
}

// 成功の表示は短く、失敗の表示は読める長さだけ残す。
const SUCCESS_MS = 3000;
const FAILURE_MS = 10_000;

// 文字列をclipboardへcopyし、結果を示す（仕様13.2）。labelは、copyしたものの名前。
export function useCopy(): {
  result: CopyResult | null;
  copy: (label: string, text: string) => Promise<void>;
} {
  const [result, setResult] = useState<CopyResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (label: string, text: string) => {
    let next: CopyResult;
    try {
      // 安全な接続（127.0.0.1を含む）でないと、clipboardは使えない。
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('このbrowserでは、clipboardへ書き込めません');
      }
      await navigator.clipboard.writeText(text);
      next = { ok: true, message: `${label}をcopyしました。` };
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : '理由は分かりません';
      next = { ok: false, message: `${label}をcopyできませんでした（${detail}）。` };
    }
    setResult(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), next.ok ? SUCCESS_MS : FAILURE_MS);
  }, []);
  return { result, copy };
}
