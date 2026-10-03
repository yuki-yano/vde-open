import { useCallback, useState } from 'react';

// View preferences are stored only in the browser. They are kept apart from the state of open documents (daemon side) (spec 13.3).
// The management token never goes here.
export function usePreference<T extends string | number>(
  key: string,
  initial: T,
  isValid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const storageKey = `vde-open.pref.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null');
      return isValid(stored) ? stored : initial;
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Even if saving fails, switch the view in this tab.
      }
    },
    [storageKey],
  );
  return [value, update];
}

export type Theme = 'light' | 'dark' | 'system';
export const isTheme = (value: unknown): value is Theme =>
  value === 'light' || value === 'dark' || value === 'system';

export type SidebarView = 'flat' | 'tree';
export const isSidebarView = (value: unknown): value is SidebarView =>
  value === 'flat' || value === 'tree';

export type ViewMode = 'preview' | 'source';
export const isViewMode = (value: unknown): value is ViewMode =>
  value === 'preview' || value === 'source';
