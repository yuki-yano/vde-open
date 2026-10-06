import { useCallback, useEffect, useRef, useState } from 'react';

export interface CopyResult {
  ok: boolean;
  message: string;
}

// Success is brief. Failures stay available until dismissed or retried.
const SUCCESS_MS = 3000;

// Copy a string to the clipboard and report the result (spec 13.2). label names what was copied.
export function useCopy(): {
  result: CopyResult | null;
  copy: (label: string, text: string) => Promise<void>;
  pending: boolean;
  dismiss: () => void;
} {
  const [result, setResult] = useState<CopyResult | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current += 1;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (label: string, text: string) => {
    const started = ++sequence.current;
    if (timer.current) clearTimeout(timer.current);
    setPending(true);
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
    if (started !== sequence.current) return;
    setPending(false);
    setResult(next);
    if (next.ok) timer.current = setTimeout(() => setResult(null), SUCCESS_MS);
  }, []);
  return { result, copy, pending, dismiss: () => setResult(null) };
}
