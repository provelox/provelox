'use client';

import { Clock, Pin } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { existing } from '@/lib/favorites';
import { useFavorites } from '@/lib/use-favorites';
import { cn } from '@/lib/utils';

export interface ShellApp {
  name: string;
  group?: string;
  project?: string;
  /** What the app is doing now: running, stopped, failed ... */
  state: string;
}

const DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500 animate-pulse',
  building: 'bg-amber-500 animate-pulse',
  failed: 'bg-red-500',
  unhealthy: 'bg-red-500 animate-pulse',
  stopped: 'bg-muted-foreground/50',
};

function List({
  title,
  icon: Icon,
  names,
  apps,
}: {
  title: string;
  icon: typeof Pin;
  names: string[];
  apps: Map<string, ShellApp>;
}) {
  const pathname = usePathname();
  if (names.length === 0) return null;
  return (
    <div className="mt-5">
      <p className="mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" /> {title}
      </p>
      <ul className="space-y-0.5">
        {names.map((n) => {
          const a = apps.get(n);
          const href = `/apps/${n}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={n}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors coarse:h-11',
                  active
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                <span
                  title={a?.state}
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    DOT[a?.state ?? ''] ?? 'bg-muted-foreground/50',
                  )}
                />
                <span className="truncate">{n}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The apps you pinned, and the ones you opened last: one click from anywhere. */
export function SidebarApps({ apps }: { apps: ShellApp[] }) {
  const { pinned, recent } = useFavorites();
  const byName = new Map(apps.map((a) => [a.name, a]));
  const known = new Set(byName.keys());
  const pins = existing(pinned, known);
  // an app that is pinned is not listed twice
  const recents = existing(recent, known)
    .filter((n) => !pins.includes(n))
    .slice(0, 4);
  return (
    <>
      <List title="Pinned" icon={Pin} names={pins} apps={byName} />
      <List title="Recent" icon={Clock} names={recents} apps={byName} />
    </>
  );
}
