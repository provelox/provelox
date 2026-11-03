'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Old settings addresses had one page with several sections (…/general#domain). Each section is a page now: this sends
 * an old link, hash and all, to where it went.
 */
export function HashRedirect({
  map,
  fallback,
  keep,
}: {
  /** hash (without #) → new address */
  map: Record<string, string>;
  /** Where a link with no (or an unknown) hash goes; none: stay */
  fallback?: string;
  /** A query string to carry along, if any */
  keep?: string;
}) {
  const router = useRouter();
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    const to = map[hash] ?? fallback;
    if (to) router.replace(`${to}${keep ?? ''}`);
  }, [map, fallback, keep, router]);
  return null;
}
