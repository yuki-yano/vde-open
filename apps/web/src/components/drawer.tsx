import { Menu, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The document list as a drawer on narrow screens. Shared by the management UI (which docks it from 900px) and the
// phone reader (always a drawer).

export function DrawerToggle({
  id,
  open,
  controls,
  onToggle,
  label,
  iconOnly = false,
}: {
  // To return focus here when the drawer closes from inside.
  id?: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
  label: string;
  // Only the icon, with the label as the accessible name (for a crowded header).
  iconOnly?: boolean;
}) {
  const icon = open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />;
  return (
    <Button
      {...(id === undefined ? {} : { id })}
      variant="ghost"
      size={iconOnly ? 'icon-sm' : 'sm'}
      aria-expanded={open}
      aria-controls={controls}
      {...(iconOnly ? { 'aria-label': label, title: label } : {})}
      onClick={onToggle}
    >
      {icon}
      {iconOnly ? null : label}
    </Button>
  );
}

export function DrawerPanel({
  id,
  open,
  docked = false,
  style,
  children,
}: {
  id: string;
  open: boolean;
  // From 900px the panel is part of the layout instead of a drawer.
  docked?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        open ? 'block' : 'hidden',
        'absolute inset-y-0 left-0 z-20 w-72 max-w-[85vw] shrink-0 border-r bg-chrome shadow-lg',
        docked &&
          'min-[900px]:static min-[900px]:block min-[900px]:max-w-none min-[900px]:shadow-none',
      )}
      style={style}
    >
      {children}
    </div>
  );
}
