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

describe('表示の権限を、版が同じまま取り直す条件', () => {
  it('取得した結果そのものは、取り直しの理由にならない', () => {
    // 取得の前は、いまの更新時刻に対して取得する。
    expect(fetchTokenOf(null, T0)).toBe(T0);
    // 取得した直後（更新時刻は取得したときと同じ）は、値が変わらない。結果が何であっても同じ。
    for (const state of [
      ready(['asset-scan-failed']),
      ready(['script-removed']),
      ready([]),
      { status: 'failed', message: 'x' } as const,
    ]) {
      expect(fetchTokenOf({ updatedAt: T0, state }, T0)).toBe(T0);
    }
  });

  it('参照を調べられなかった文書は、取得の後に文書の状態が更新されたら取り直す', () => {
    const failed = { updatedAt: T0, state: ready(['script-removed', 'asset-scan-failed']) };
    expect(fetchTokenOf(failed, T1)).toBe(T1);
    // 取り直した後（取得したときの更新時刻がT1）は、また変わらない。
    expect(fetchTokenOf({ ...failed, updatedAt: T1 }, T1)).toBe(T1);
    // 取り直しに失敗して前の結果を保っている場合も、試みた時点を記録していれば繰り返さない。
    expect(fetchTokenOf({ updatedAt: T1, state: failed.state }, T1)).toBe(T1);
  });

  it('調べ終えた文書は、文書の状態が更新されても取り直さない（表示を作り直さない）', () => {
    expect(fetchTokenOf({ updatedAt: T0, state: ready(['script-removed']) }, T1)).toBe(T0);
    expect(fetchTokenOf({ updatedAt: T0, state: { status: 'failed', message: 'x' } }, T1)).toBe(T0);
  });
});
