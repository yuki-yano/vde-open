import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

export const LONG_PRESS_MS = 500;
// A finger that moves further than this is scrolling, not holding.
const MOVE_TOLERANCE_PX = 10;

// Calls open on a held press: iOS Safari fires no contextmenu for a long touch, so a timer decides. A right click,
// a long touch on Android, the context menu key, and Shift+F10 arrive as contextmenu and open it too. When the timer
// and contextmenu both fire for one press, open runs twice, so it must be idempotent. The click that ends a held press
// is swallowed, so the element does not also do its own action.
export function useLongPress(open: () => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const held = useRef(false);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => {
    const current = press;
    return () => {
      if (current.current) clearTimeout(current.current.timer);
    };
  }, []);
  return {
    onPointerDown: (event: PointerEvent) => {
      held.current = false;
      cancel();
      if (!event.isPrimary || event.button !== 0) return;
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null;
          held.current = true;
          open();
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (event: PointerEvent) => {
      const start = press.current;
      if (
        start &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // A mouse that leaves the element is released elsewhere, where this element sees no pointerup.
    onPointerLeave: cancel,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      // During a press (a long touch on Android), a click may still end it.
      if (press.current) held.current = true;
      cancel();
      open();
    },
    onClickCapture: (event: MouseEvent) => {
      // A keyboard click has no press to end, so it always counts.
      if (!held.current || event.detail === 0) return;
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
