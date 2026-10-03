import type { RenderGrantResult } from '@vde-open/shared';
import { describe, expect, it } from 'vitest';

import { fetchTokenOf, type GrantState } from './use-render-grant.ts';

function ready(codes: string[]): GrantState {
  return {
    status: 'ready',
    grant: {
      diagnostics: codes.map((code) => ({ code, target: null, count: 1 })),
    } as unknown as RenderGrantResult,
  };
}

const T0 = '2026-10-03T00:00:00.000Z';
const T1 = '2026-10-03T00:00:05.000Z';

describe('when to refetch a render grant for the same revision', () => {
  it('the fetched result itself is not a reason to refetch', () => {
    // Before the fetch, fetch for the current update time.
    expect(fetchTokenOf(null, T0)).toBe(T0);
    // Right after the fetch (the update time is the same as at fetch), the value does not change, whatever the result.
    for (const state of [
      ready(['asset-scan-failed']),
      ready(['script-removed']),
      ready([]),
      { status: 'failed', message: 'x' } as const,
    ]) {
      expect(fetchTokenOf({ updatedAt: T0, state }, T0)).toBe(T0);
    }
  });

  it("a document whose references could not be scanned is refetched when the document's state is updated after the fetch", () => {
    const failed = { updatedAt: T0, state: ready(['script-removed', 'asset-scan-failed']) };
    expect(fetchTokenOf(failed, T1)).toBe(T1);
    // After the refetch (the update time at fetch is T1), it does not change again.
    expect(fetchTokenOf({ ...failed, updatedAt: T1 }, T1)).toBe(T1);
    // Even when the refetch failed and the previous result is kept, recording the attempt time prevents repeating.
    expect(fetchTokenOf({ updatedAt: T1, state: failed.state }, T1)).toBe(T1);
  });

  it("a document whose scan finished is not refetched when the document's state is updated (the view is not rebuilt)", () => {
    expect(fetchTokenOf({ updatedAt: T0, state: ready(['script-removed']) }, T1)).toBe(T0);
    expect(fetchTokenOf({ updatedAt: T0, state: { status: 'failed', message: 'x' } }, T1)).toBe(T0);
  });
});
