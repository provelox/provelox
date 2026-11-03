'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { APP_TABS as TABS } from '@/lib/nav';
import { cn } from '@/lib/utils';

export function AppTabs({ name }: { name: string }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b lg:hidden">
      {TABS.map((t) => {
        const href = `/apps/${name}${t.href}`;
        const active = pathname === href;
        return (
          <Link
            key={t.label}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm coarse:py-3',
              active
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
