'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { watchDelayMs } from '@/lib/app-watch';

/**
 * Renders nothing. While `active` (the app is deploying or starting) it asks the page to fetch fresh data, layout
 * included, until the status settles. Without it the header keeps what it was drawn with, since a layout stays mounted
 * as you move between an app's tabs, and says "Deploying" long after it is running.
 */
export function StatusWatcher({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
      timer = setTimeout(tick, watchDelayMs(Date.now() - started));
    };
    timer = setTimeout(tick, watchDelayMs(0));
    return () => clearTimeout(timer);
  }, [active, router]);
  return null;
}
