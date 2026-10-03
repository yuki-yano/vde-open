import { useCallback, useEffect, useRef, useState } from 'react';

export interface CopyResult {
  ok: boolean;
  message: string;
}

// Show success briefly; keep failures long enough to read.
const SUCCESS_MS = 3000;
const FAILURE_MS = 10_000;

// Copy a string to the clipboard and report the result (spec 13.2). label names what was copied.
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
      // The clipboard is available only on a secure connection (including 127.0.0.1).
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('This browser cannot write to the clipboard');
      }
      await navigator.clipboard.writeText(text);
      next = { ok: true, message: `Copied the ${label}.` };
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : 'unknown reason';
      next = { ok: false, message: `Could not copy the ${label} (${detail}).` };
    }
    setResult(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), next.ok ? SUCCESS_MS : FAILURE_MS);
  }, []);
  return { result, copy };
}
