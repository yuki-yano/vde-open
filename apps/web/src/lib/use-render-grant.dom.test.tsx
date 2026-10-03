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
  // The grant of the view on screen at the moment the release started.
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

// With scanFailed, the grant is refetched every time the document's state is updated.
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
  // A value that causes a screen update unrelated to the grant.
  tick?: number;
  // Called right after this render reaches the screen (before effects run).
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

// Wait for screen updates and effects to settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
// Wait until the condition holds. Under the load of tests running in parallel, screen updates and effects are delayed.
// To check that something does not happen, wait with settle.
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const requested = (count: number) => until(() => pending.length >= count);
const released = (count: number) => until(() => releases.length >= count);

async function showFirst(scanFailed: boolean): Promise<void> {
  root.render(<Probe updatedAt={T0} />);
  await requested(1);
  pending[0]?.resolve(grant('g1', scanFailed));
  await until(() => displayedGrant() === 'g1');
  expect(displayedGrant()).toBe('g1');
}

describe('order of releasing render grants', () => {
  it('does not refetch because of the fetched result, and does not release the fetched grant', async () => {
    await showFirst(true);
    expect(pending).toHaveLength(1);
    expect(releases).toEqual([]);
  });

  it('after a refetch, releases the previous grant once the new view is on screen', async () => {
    await showFirst(true);
    root.render(<Probe updatedAt={T1} />);
    await requested(2);
    await settle();
    expect(pending).toHaveLength(2);
    expect(releases).toEqual([]);
    pending[1]?.resolve(grant('g2', false));
    await released(1);
    expect(displayedGrant()).toBe('g2');
    expect(releases).toEqual([{ grants: ['g1'], displayed: 'g2' }]);
    // A document whose scan finished is not refetched when its state is updated.
    root.render(<Probe updatedAt={T2} />);
    await settle();
    expect(pending).toHaveLength(2);
  });

  it('does not release the on-screen grant first even when an unrelated screen update overlaps', async () => {
    await showFirst(true);
    root.render(<Probe updatedAt={T1} />);
    await requested(2);
    expect(pending).toHaveLength(2);

    // During the refetch, an update unrelated to the grant reaches the screen.
    // Right after that, before that render's effect runs, the new grant arrives.
    root.render(
      <Probe updatedAt={T1} tick={1} onCommit={() => pending[1]?.resolve(grant('g2', false))} />,
    );
    await released(1);
    expect(displayedGrant()).toBe('g2');
    // The previous render's effect does not release g1, which is still on screen. It is released after the g2 view is on screen.
    expect(releases).toEqual([{ grants: ['g1'], displayed: 'g2' }]);
  });

  it('when a refetch fails, keeps the grant in use and does not keep retrying', async () => {
    await showFirst(true);
    root.render(<Probe updatedAt={T1} />);
    await requested(2);
    pending[1]?.reject(new Error('failed'));
    await settle();
    expect(displayedGrant()).toBe('g1');
    expect(pending).toHaveLength(2);
    expect(releases).toEqual([]);
    // When the document's state is next updated, try once more.
    root.render(<Probe updatedAt={T2} />);
    await requested(3);
    expect(pending).toHaveLength(3);
  });

  it('when switching to another revision, releases the previous grant after the previous view has left the screen', async () => {
    await showFirst(false);
    root.render(<Probe revision="rev_2" updatedAt={T1} />);
    await requested(2);
    await settle();
    // While waiting for the new revision's grant, the previous view is off screen. The previous grant is not released yet.
    expect(displayedGrant()).toBe('');
    expect(releases).toEqual([]);
    pending[1]?.resolve(grant('g2', false));
    await released(1);
    expect(releases).toEqual([{ grants: ['g1'], displayed: 'g2' }]);

    // Even when the switch fails, the grant no longer in use is released.
    root.render(<Probe revision="rev_3" updatedAt={T1} />);
    await requested(3);
    pending[2]?.reject(new Error('failed'));
    await released(2);
    expect(releases.at(-1)).toEqual({ grants: ['g2'], displayed: '' });
  });

  it('when the view is dismissed, releases the grant in use; a grant that became unnecessary while pending is released without being used', async () => {
    await showFirst(false);
    root.render(<Probe revision="rev_2" updatedAt={T1} />);
    await requested(2);
    root.unmount();
    await released(1);
    expect(releases).toEqual([{ grants: ['g1'], displayed: '' }]);
    pending[1]?.resolve(grant('g2', false));
    await released(2);
    expect(releases.at(-1)).toEqual({ grants: ['g2'], displayed: '' });
    root = createRoot(container);
  });
});

describe('choosing which grants may be released', () => {
  it('keeps the on-screen grant and releases the rest', () => {
    expect(splitRetired(['g1'], 'g1')).toEqual({ release: [], keep: ['g1'] });
    expect(splitRetired(['g1'], 'g2')).toEqual({ release: ['g1'], keep: [] });
    expect(splitRetired(['g1', 'g2'], 'g2')).toEqual({ release: ['g1'], keep: ['g2'] });
    expect(splitRetired(['g1'], null)).toEqual({ release: ['g1'], keep: [] });
    expect(splitRetired([], 'g1')).toEqual({ release: [], keep: [] });
  });
});
