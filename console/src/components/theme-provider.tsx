'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { isTheme, resolveTheme, THEME_KEY, type Theme } from '@/lib/theme';

interface ThemeContext {
  /** What the person chose: system, light or dark */
  theme: Theme;
  /** What is on screen now */
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const Ctx = createContext<ThemeContext>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => undefined,
});

export const useTheme = () => useContext(Ctx);

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', cb);
  // the choice changed in another tab
  const onStorage = (e: StorageEvent) => e.key === THEME_KEY && cb();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener('change', cb);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Holds the person's theme choice. It is kept in this browser (localStorage) and applied as the `dark` class on
 * <html>; the head script applies it before first paint, this keeps it right afterwards.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(
    subscribe,
    readTheme,
    (): Theme => 'system',
  );
  const systemDark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
  const resolved: 'light' | 'dark' = resolveTheme(theme, systemDark);
  // While React hydrates it reads the server's defaults, not this browser's choice. Applying those would strip the
  // class the head script already set, and the page would flash light before settling. Wait until the real values are in.
  const ready = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (ready)
      document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [ready, resolved]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // the choice still applies for this visit
    }
    notify();
  }, []);

  const value = useMemo<ThemeContext>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
