import { useRef, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

// Resizes the pane to the right of the handle: dragging left or ArrowLeft widens it, ArrowRight narrows it,
// and Home and End jump to the limits. onResize receives the requested width; the caller clamps it.
export function PaneResizeHandle({
  label,
  controls,
  width,
  min,
  max,
  onResize,
  className,
  style,
}: {
  label: string;
  controls: string;
  width: number;
  min: number;
  max: number;
  onResize: (next: number) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      style={style}
      className={cn(
        'relative w-2 shrink-0 touch-none cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-border hover:bg-muted hover:before:bg-primary/60 focus-visible:bg-primary/10 focus-visible:before:bg-primary focus-visible:outline-none active:bg-primary/10 active:before:bg-primary',
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        // Keep receiving moves over a document iframe until pointerup or pointercancel.
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (
          !current ||
          current.pointerId !== event.pointerId ||
          !event.currentTarget.hasPointerCapture(event.pointerId)
        )
          return;
        onResize(current.width + current.x - event.clientX);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const next =
          event.key === 'ArrowLeft'
            ? width + 16
            : event.key === 'ArrowRight'
              ? width - 16
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : null;
        if (next === null) return;
        event.preventDefault();
        onResize(next);
      }}
    />
  );
}
