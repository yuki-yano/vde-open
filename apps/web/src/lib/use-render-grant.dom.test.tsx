// @vitest-environment happy-dom
import type { RenderGrantResult } from '@vde-open/shared';
import { useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from './api.ts';
import { splitRetired, useRenderGrant } from './use-render-grant.ts';

interface Deferred {
  resolve: (grant: RenderGrantResult) => void;
  reject: (error: Error) => void;
}

interface Release {
  grants: string[];
  // 権限を返す処理を始めた瞬間に、画面に出ていた表示の権限。
  displayed: string;
}

let container: HTMLElement;
let root: Root;
let pending: Deferred[];
let releases: Release[];
let api: Api;

const T0 = '2026-10-03T00:00:00.000Z';
const T1 = '2026-10-03T00:00:05.000Z';
const T2 = '2026-10-03T00:00:10.000Z';

// scanFailedなら、文書の状態が更新されるたびに取り直す対象になる。
function grant(name: string, scanFailed: boolean): RenderGrantResult {
  return {
    grant: name,
    diagnostics: scanFailed ? [{ code: 'asset-scan-failed', target: null, count: 1 }] : [],
  } as unknown as RenderGrantResult;
}

const displayedGrant = () =>
  container.querySelector('[data-grant]')?.getAttribute('data-grant') ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  pending = [];
  releases = [];
  api = {
    renderGrant: () =>
      new Promise<RenderGrantResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    releaseGrants: (grants: string[]) => {
      releases.push({ grants, displayed: displayedGrant() });
      return Promise.resolve();
    },
  } as unknown as Api;
});

afterEach(() => {
  root.unmount();
  container.remove();
});

interface ProbeProps {
  revision?: string | null;
  updatedAt: string;
  // 権限とは関係のない画面の更新を起こすための値。
  tick?: number;
  // この描画が画面へ反映された直後（effectが動く前）に呼ばれる。
  onCommit?: () => void;
}

function Probe({ revision = 'rev_1', updatedAt, tick = 0, onCommit }: ProbeProps): ReactNode {
  const state = useRenderGrant(api, 'doc_1', revision, updatedAt);
  useLayoutEffect(() => {
    onCommit?.();
  });
  return (
    <div data-grant={state.status === 'ready' ? state.grant.grant : ''} data-tick={tick}>
      {state.status}
    </div>
  );
}

// 画面の更新とeffectが落ち着くまで待つ。
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function showFirst(scanFailed: boolean): Promise<void> {
  root.render(<Probe updatedAt={T0} />);
  await settle();
  pending[0]?.resolve(grant('g1', scanFailed));
  await settle();
  expect(displayedGrant()).toBe('g1');
}

describe('表示の権限を返す順序', () => {
  it('取得した結果を理由に取り直さず、取得した権限も返さない', async () => {
    await showFirst(true);
    expect(pending).toHaveLength(1);
    expect(releases).toEqual([]);
  });

  it('取り直したら、新しい表示が画面へ出た後で、前の権限を返す', async () => {
    await showFirst(true);
    root.render(<Probe updatedAt={T1} />);
    await settle();
    expect(pending).toHaveLength(2);
    expect(releases).toEqual([]);
    pending[1]?.resolve(grant('g2', false));
    await settle();
    expect(displayedGrant()).toBe('g2');
    expect(releases).toEqual([{ grants: ['g1'], displayed: 'g2' }]);
    // 調べ終えた文書は、文書の状態が更新されても取り直さない。
    root.render(<Probe updatedAt={T2} />);
    await settle();
    expect(pending).toHaveLength(2);
  });

  it('別の画面の更新が重なっても、画面に出ている権限を先に返さない', async () => {
    await showFirst(true);
    root.render(<Probe updatedAt={T1} />);
    await settle();
    expect(pending).toHaveLength(2);

    // 取り直しの途中で、権限とは関係のない更新が画面へ反映される。
    // その反映の直後、その描画のeffectが動く前に、新しい権限が届く。
    root.render(
      <Probe updatedAt={T1} tick={1} onCommit={() => pending[1]?.resolve(grant('g2', false))} />,
    );
    await settle();
    expect(displayedGrant()).toBe('g2');
    // 前の描画のeffectは、まだ画面に出ているg1を返さない。返すのは、g2の表示が反映された後。
    expect(releases).toEqual([{ grants: ['g1'], displayed: 'g2' }]);
  });

  it('取り直しに失敗したら、表示中の権限を保ち、取り直しを繰り返さない', async () => {
    await showFirst(true);
    root.render(<Probe updatedAt={T1} />);
    await settle();
    pending[1]?.reject(new Error('failed'));
    await settle();
    expect(displayedGrant()).toBe('g1');
    expect(pending).toHaveLength(2);
    expect(releases).toEqual([]);
    // 次に文書の状態が更新されたら、もう一度だけ試す。
    root.render(<Probe updatedAt={T2} />);
    await settle();
    expect(pending).toHaveLength(3);
  });

  it('別の版へ切り替えると、前の版の表示が外れてから、前の権限を返す', async () => {
    await showFirst(false);
    root.render(<Probe revision="rev_2" updatedAt={T1} />);
    await settle();
    // 新しい版の権限を待つ間、前の版の表示は外れている。前の権限は、まだ返していない。
    expect(displayedGrant()).toBe('');
    expect(releases).toEqual([]);
    pending[1]?.resolve(grant('g2', false));
    await settle();
    expect(releases).toEqual([{ grants: ['g1'], displayed: 'g2' }]);

    // 切り替えに失敗した場合も、使わなくなった権限を返す。
    root.render(<Probe revision="rev_3" updatedAt={T1} />);
    await settle();
    pending[2]?.reject(new Error('failed'));
    await settle();
    expect(releases.at(-1)).toEqual({ grants: ['g2'], displayed: '' });
  });

  it('表示をやめたら、使っていた権限を返す。待っている間に不要になった権限は、使わずに返す', async () => {
    await showFirst(false);
    root.render(<Probe revision="rev_2" updatedAt={T1} />);
    await settle();
    root.unmount();
    await settle();
    expect(releases).toEqual([{ grants: ['g1'], displayed: '' }]);
    pending[1]?.resolve(grant('g2', false));
    await settle();
    expect(releases.at(-1)).toEqual({ grants: ['g2'], displayed: '' });
    root = createRoot(container);
  });
});

describe('返してよい権限の選び方', () => {
  it('画面に出している権限は残し、それ以外を返す', () => {
    expect(splitRetired(['g1'], 'g1')).toEqual({ release: [], keep: ['g1'] });
    expect(splitRetired(['g1'], 'g2')).toEqual({ release: ['g1'], keep: [] });
    expect(splitRetired(['g1', 'g2'], 'g2')).toEqual({ release: ['g1'], keep: ['g2'] });
    expect(splitRetired(['g1'], null)).toEqual({ release: ['g1'], keep: [] });
    expect(splitRetired([], 'g1')).toEqual({ release: [], keep: [] });
  });
});
