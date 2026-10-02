import { useCallback, useState } from 'react';

// 表示の好みはbrowserにだけ保存する。開いている文書の状態（daemon側）とは混ぜない（仕様13.3）。
// 管理tokenはここに入れない。
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
        // 保存できなくても、このtabの表示は切り替える。
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
