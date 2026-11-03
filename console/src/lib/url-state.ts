'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/** The address with one query parameter set, or removed when it holds the default. Everything else in it is kept. */
export function withParam(
  href: string,
  key: string,
  value: string,
  fallback = '',
): string {
  const url = new URL(href, 'http://local');
  if (value === fallback || value === '') url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A piece of page state that lives in the address (?q=...), so a search or a filter is still there when you come
 * back, reload, or share the link. It changes the address in place, without adding a history entry for every
 * keystroke, and follows the address when it changes by navigation (back, forward).
 */
export function useUrlState(
  key: string,
  fallback = '',
): [string, (value: string) => void] {
  const params = useSearchParams();
  const fromUrl = params.get(key) ?? fallback;
  const [value, setValue] = useState(fromUrl);
  useEffect(() => setValue(fromUrl), [fromUrl]);
  const set = useCallback(
    (next: string) => {
      setValue(next);
      window.history.replaceState(
        window.history.state,
        '',
        withParam(window.location.href, key, next, fallback),
      );
    },
    [key, fallback],
  );
  return [value, set];
}
