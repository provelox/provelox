'use client';

import { useCallback, useSyncExternalStore } from 'react';
import {
  parseNames,
  renamed,
  PINNED_KEY,
  RECENT_KEY,
  togglePin,
  visit,
} from './favorites';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // remembering is a convenience only
  }
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) =>
    (e.key === PINNED_KEY || e.key === RECENT_KEY) && cb();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

// useSyncExternalStore needs the same value back while nothing changed: hand out the stored text, parse it once per use
const text = (key: string) => () => read(key);
const none = () => null;

export function useFavorites() {
  const pinnedText = useSyncExternalStore(subscribe, text(PINNED_KEY), none);
  const recentText = useSyncExternalStore(subscribe, text(RECENT_KEY), none);
  const pinned = parseNames(pinnedText);
  const recent = parseNames(recentText);
  const toggle = useCallback(
    (app: string) =>
      write(PINNED_KEY, togglePin(parseNames(read(PINNED_KEY)), app)),
    [],
  );
  return { pinned, recent, toggle };
}

/** Notes that an app was opened. */
export function recordVisit(app: string) {
  const cur = parseNames(read(RECENT_KEY));
  if (cur[0] === app) return;
  write(RECENT_KEY, visit(cur, app));
}

/** An app was renamed: its pin and its place in "recent" follow it. */
export function renameFavorite(from: string, to: string) {
  write(PINNED_KEY, renamed(parseNames(read(PINNED_KEY)), from, to));
  write(RECENT_KEY, renamed(parseNames(read(RECENT_KEY)), from, to));
}
