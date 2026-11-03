'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Combobox } from '@/components/ui/combobox';
import { SETTINGS_GROUPS, SETTINGS_PAGES } from '@/lib/nav';
import { cn } from '@/lib/utils';

/** Settings' own list: every page in its group. On a narrow screen it is a searchable menu instead. */
export function SettingsNav() {
  const pathname = usePathname();
  const router = useRouter();
  const current = SETTINGS_PAGES.find(
    (p) => pathname === p.href || pathname.startsWith(`${p.href}/`),
  );
  return (
    <>
      <div className="lg:hidden">
        <Combobox
          value={current?.href ?? ''}
          onValueChange={(href) => router.push(href)}
          aria-label={`Settings page: ${current?.label ?? 'Settings'}`}
          placeholder="Settings"
          className="w-full"
          searchable
          options={SETTINGS_PAGES.map((p) => ({
            value: p.href,
            label: p.label,
            icon: <p.icon className="h-4 w-4 text-muted-foreground" />,
          }))}
        />
      </div>
      <nav
        aria-label="Settings"
        className="sticky top-20 hidden flex-col gap-5 text-sm lg:flex"
      >
        <Link
          href="/settings"
          aria-current={pathname === '/settings' ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5',
            pathname === '/settings'
              ? 'bg-secondary font-medium text-foreground'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
          )}
        >
          Overview
        </Link>
        {SETTINGS_GROUPS.map((g) => (
          <div key={g.id}>
            <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {g.label}
            </p>
            <ul className="space-y-0.5">
              {g.pages.map((p) => {
                const active = p === current;
                return (
                  <li key={p.id}>
                    <Link
                      href={p.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-3 py-1.5 transition-colors',
                        active
                          ? 'bg-secondary font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                    >
                      <p.icon className="h-4 w-4 shrink-0" />
                      {p.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
