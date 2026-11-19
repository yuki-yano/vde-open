// @vitest-environment happy-dom
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PULL_TO_RELOAD_PX, usePullToReload } from './use-pull-to-reload.ts';

let container: HTMLDivElement;
let root: Root;
let reloads: number;

function Page({ enabled }: { enabled: boolean }) {
  const page = useRef<HTMLDivElement>(null);
  const progress = usePullToReload(page, enabled, () => {
    reloads += 1;
  });
  return (
    <div ref={page}>
      <output data-testid="progress">{progress}</output>
      <main data-testid="scroller" style={{ overflowY: 'auto', height: '100px' }}>
        <p data-testid="text">text</p>
      </main>
    </div>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  reloads = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const progress = () => Number(container.querySelector('output')?.textContent);
const target = () => container.querySelector('[data-testid="text"]') as HTMLElement;
function touch(type: string, x: number, y: number) {
  const point = { identifier: 1, target: target(), clientX: x, clientY: y };
  act(() => {
    target().dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        touches: type === 'touchend' ? [] : [point as unknown as Touch],
      }),
    );
  });
}
function pull(dx: number, dy: number) {
  touch('touchstart', 10, 10);
  touch('touchmove', 10 + dx, 10 + dy);
  touch('touchend', 10 + dx, 10 + dy);
}

describe('pull down to reload (phone reader opened from the home screen)', () => {
  it('reloads once a pull from the top passes the threshold, and shows how far it came meanwhile', () => {
    act(() => root.render(<Page enabled />));
    touch('touchstart', 10, 10);
    touch('touchmove', 10, 10 + PULL_TO_RELOAD_PX / 2);
    expect(progress()).toBeCloseTo(0.5);
    touch('touchend', 10, 10 + PULL_TO_RELOAD_PX / 2);
    expect(reloads).toBe(0);
    expect(progress()).toBe(0);
    pull(0, PULL_TO_RELOAD_PX + 1);
    expect(reloads).toBe(1);
  });

  it('does not reload for a sideways swipe, a scrolled-down page, or outside the home screen', () => {
    act(() => root.render(<Page enabled />));
    pull(PULL_TO_RELOAD_PX * 2, PULL_TO_RELOAD_PX + 1);
    // A swipe that began sideways stays a swipe when it then goes down.
    touch('touchstart', 10, 10);
    touch('touchmove', 50, 10);
    touch('touchmove', 50, 10 + PULL_TO_RELOAD_PX * 2);
    touch('touchend', 50, 10 + PULL_TO_RELOAD_PX * 2);
    // A pull past the threshold that the browser cancels does not reload.
    touch('touchstart', 10, 10);
    touch('touchmove', 10, 10 + PULL_TO_RELOAD_PX + 1);
    touch('touchcancel', 10, 10 + PULL_TO_RELOAD_PX + 1);
    (container.querySelector('[data-testid="scroller"]') as HTMLElement).scrollTop = 40;
    pull(0, PULL_TO_RELOAD_PX + 1);
    expect(reloads).toBe(0);

    (container.querySelector('[data-testid="scroller"]') as HTMLElement).scrollTop = 0;
    act(() => root.render(<Page enabled={false} />));
    pull(0, PULL_TO_RELOAD_PX + 1);
    expect(reloads).toBe(0);
  });
});
