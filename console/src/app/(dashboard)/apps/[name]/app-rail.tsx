'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AppNavItem } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * Everything about the app in one list, on the left: its pages, and under the page you are on the sections it scrolls
 * through (with a marker that follows the scroll). Replaces the row of tabs on wide screens.
 */
export function AppRail({
  name,
  items,
}: {
  name: string;
  items: AppNavItem[];
}) {
  const pathname = usePathname();
  const current = items.find((i) => pathname === `/apps/${name}${i.href}`);
  const [active, setActive] = useState<string | undefined>();

  useEffect(() => {
    setActive(undefined);
    const els = (current?.sections ?? [])
      .map((s) => document.getElementById(s.id))
      .filter((e): e is HTMLElement => !!e);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -60% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [current]);

  return (
    <nav
      aria-label="App"
      className="sticky top-20 flex flex-col gap-0.5 text-sm"
    >
      {items.map((item) => {
        const href = `/apps/${name}${item.href}`;
        const here = item === current;
        return (
          <div key={item.label}>
            <Link
              href={href}
              aria-current={here ? 'page' : undefined}
              className={cn(
                'flex items-center rounded-md px-3 py-1.5',
                here
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
            {here && item.sections.length > 0 && (
              <ul className="my-1 ml-3 flex flex-col gap-0.5 border-l pl-2">
                {item.sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      aria-current={active === s.id ? 'location' : undefined}
                      className={cn(
                        'flex items-center justify-between rounded-md px-2.5 py-1 text-[13px]',
                        active === s.id
                          ? 'font-medium text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {s.label}
                      {s.count !== undefined && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {s.count}
                        </span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
