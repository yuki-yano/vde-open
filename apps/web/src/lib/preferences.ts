import { useCallback, useState } from 'react';

// Read before mounting as well as from hooks, so the saved appearance is used from the first render.
export function readPreference<T extends string | number>(
  key: string,
  initial: T,
  isValid: (value: unknown) => value is T,
): T {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(`vde-open.pref.${key}`) ?? 'null',
    );
    return isValid(stored) ? stored : initial;
  } catch {
    return initial;
  }
}

// View preferences are stored only in the browser. They are kept apart from the state of open documents (daemon side) (spec 13.3).
// The management token never goes here.
export function usePreference<T extends string | number>(
  key: string,
  initial: T,
  isValid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const storageKey = `vde-open.pref.${key}`;
  const [value, setValue] = useState<T>(() => readPreference(key, initial, isValid));
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

export const colorPalettes = [
  { value: 'standard', label: 'Standard' },
  { value: 'github', label: 'GitHub' },
  { value: 'gruvbox', label: 'Gruvbox' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'github-high-contrast', label: 'GitHub High Contrast' },
] as const;
export type ColorPalette = (typeof colorPalettes)[number]['value'];
export const isColorPalette = (value: unknown): value is ColorPalette =>
  colorPalettes.some((palette) => palette.value === value);

export function applyAppearance(theme: Theme, palette: ColorPalette): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  window.document.documentElement.classList.toggle('dark', dark);
  window.document.documentElement.dataset.colorPalette = palette;
}

export type SidebarView = 'flat' | 'tree';
export const isSidebarView = (value: unknown): value is SidebarView =>
  value === 'flat' || value === 'tree';

export type ViewMode = 'preview' | 'source';
export const isViewMode = (value: unknown): value is ViewMode =>
  value === 'preview' || value === 'source';

export type MarkdownWidth = 'standard' | 'wide';
export const isMarkdownWidth = (value: unknown): value is MarkdownWidth =>
  value === 'standard' || value === 'wide';
