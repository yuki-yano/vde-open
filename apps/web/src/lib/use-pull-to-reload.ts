import { useEffect, useEffectEvent, useState, type RefObject } from 'react';

// How far a finger pulls down before letting go reloads.
export const PULL_TO_RELOAD_PX = 72;
// Movement below this does not yet decide whether the touch is a pull or a sideways swipe.
const DECIDE_PX = 10;

// Opened from the home screen: there the browser gives no pull-to-refresh of its own. A browser tab keeps its own.
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Whether nothing between the touched element and the root is scrolled away from its top.
function atTop(target: EventTarget | null, root: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return false;
    if (node === root) return true;
  }
  return true;
}

// Pulling down from the top of the root and letting go past the threshold calls reload. Returns how far the current
// pull has come (0 to 1) for an indicator. A touch inside an iframe never reaches the root, so pull from outside it.
export function usePullToReload(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
  reload: () => void,
): number {
  const [progress, setProgress] = useState(0);
  const onReload = useEffectEvent(reload);
  useEffect(() => {
    const element = root.current;
    if (!enabled || element === null) return;
    let start: { x: number; y: number } | null = null;
    let distance = 0;
    let pulling = false;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch !== undefined && atTop(event.target, element)
          ? { x: touch.clientX, y: touch.clientY }
          : null;
      distance = 0;
      pulling = false;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (start === null || touch === undefined) return;
      const down = touch.clientY - start.y;
      const sideways = Math.abs(touch.clientX - start.x);
      // The first clear movement decides: a touch that began sideways (or upwards) stays out until it lifts.
      if (!pulling) {
        if (Math.max(Math.abs(down), sideways) < DECIDE_PX) return;
        if (down <= sideways) {
          start = null;
          return;
        }
        pulling = true;
      }
      distance = Math.max(0, down);
      setProgress(Math.min(1, distance / PULL_TO_RELOAD_PX));
    };
    const onEnd = (event: TouchEvent) => {
      if (event.type === 'touchend' && start !== null && distance >= PULL_TO_RELOAD_PX) onReload();
      start = null;
      distance = 0;
      pulling = false;
      setProgress(0);
    };
    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: true });
    element.addEventListener('touchend', onEnd);
    element.addEventListener('touchcancel', onEnd);
    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', onEnd);
    };
  }, [root, enabled]);
  return progress;
}
