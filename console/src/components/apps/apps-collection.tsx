'use client';

import {
  Boxes,
  Database,
  ExternalLink,
  Globe,
  LayoutGrid,
  List,
  MoreHorizontal,
  Play,
  RotateCw,
  ScrollText,
  Search,
  Square,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { restartAppAction, updateAppAction } from '@/actions/apps';
import { UpgradeBadge } from '@/components/apps/upgrade-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  SORT_LABEL,
  sortRows,
  statusOf,
  type AppRow,
  type AppStatus,
  shortImage,
  type SortKey,
} from '@/app/(dashboard)/apps/app-row';
import type { UsageByApp } from '@/lib/backend';
import { apiGet } from '@/lib/client-api';
import { formatBytes, timeAgo } from '@/lib/format';
import { useUrlState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

type Filter = 'all' | AppStatus;
const FILTERS: Filter[] = [
  'all',
  'running',
  'starting',
  'failed',
  'unhealthy',
  'stopped',
  'building',
];

const DOT: Record<AppStatus, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500 animate-pulse',
  failed: 'bg-red-500',
  stopped: 'bg-muted-foreground/50',
  unhealthy: 'bg-red-500 animate-pulse',
  building: 'bg-amber-500 animate-pulse',
};

const VIEW_KEY = 'provelox:group:view';

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium tabular-nums">{children}</span>
    </div>
  );
}

/** One app's state as a pill: a coloured dot and a word. */
function StatusPill({ row }: { row: AppRow }) {
  const status = statusOf(row);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs">
      <span className={cn('h-2 w-2 rounded-full', DOT[status])} />
      {status}
    </span>
  );
}

function Address({ row }: { row: AppRow }) {
  if (!row.exposed)
    return <span className="text-muted-foreground">Not served over HTTP</span>;
  if (row.domains.length === 0)
    return <span className="text-muted-foreground">No public address</span>;
  const first = row.domains[0];
  return (
    <span className="inline-flex max-w-full items-center gap-x-2">
      <a
        href={first.url}
        target="_blank"
        rel="noreferrer noopener"
        title={first.host}
        className="inline-flex min-w-0 items-center gap-1 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate">{first.host}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
      {row.domains.length > 1 && (
        <span className="text-xs text-muted-foreground">
          +{row.domains.length - 1} more
        </span>
      )}
    </span>
  );
}

/**
 * The apps of one group or one project as a searchable, sortable table or grid. A group and a project differ in what you
 * can do with the set, not in how its apps are shown, so both pages use this.
 */
export function AppsCollection({
  rows,
  noun = 'app',
  nameOf = (r) => r.name,
  subtitleOf,
  extraMenu,
  bulk,
}: {
  rows: AppRow[];
  /** What the members are called: "app" in a group, "service" in a project */
  noun?: string;
  /** What to call a row: a project's services are known by their compose name */
  nameOf?: (r: AppRow) => string;
  /** A second line under the name (the image, say) */
  subtitleOf?: (r: AppRow) => string | undefined;
  /** More items for a row's menu, after the standard ones */
  extraMenu?: (r: AppRow, refresh: () => void) => React.ReactNode;
  /** Tick boxes beside the rows, and one action for the ticked ones. `done` clears the ticks. */
  bulk?: {
    label: string;
    icon?: React.ReactNode;
    run: (names: string[], done: () => void) => void;
  };
}) {
  const router = useRouter();
  const [query, setQuery] = useUrlState('q');
  const [filterParam, setFilterParam] = useUrlState('status', 'all');
  const filter: Filter = FILTERS.includes(filterParam as Filter)
    ? (filterParam as Filter)
    : 'all';
  const [sort, setSort] = useState<SortKey>('name');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [pending, startTransition] = useTransition();
  const [ticked, setTicked] = useState<string[]>([]);
  const tick = (name: string, on: boolean) =>
    setTicked((cur) =>
      on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name),
    );

  // How the page is laid out is remembered in this browser
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === 'grid') setView('grid');
    } catch {
      // a convenience only
    }
  }, []);
  const chooseView = (v: 'list' | 'grid') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // a convenience only
    }
  };

  const usage = useQuery({
    queryKey: ['usage-all'],
    queryFn: () => apiGet<UsageByApp>('usage'),
    enabled: rows.some((r) => r.instanceCount > 0),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sortRows(
        rows
          .filter((r) => filter === 'all' || statusOf(r) === filter)
          .filter((r) => {
            if (!q) return true;
            const hay = [r.name, nameOf(r), ...r.domains.map((d) => d.host)]
              .join(' ')
              .toLowerCase();
            return q.split(/\s+/).every((t) => hay.includes(t));
          }),
        sort,
        usage.data,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filter, q, sort, usage.data],
  );

  // Only apps that are still on the page count
  const names = ticked.filter((n) => rows.some((r) => r.name === n));
  const allTicked =
    visible.length > 0 && visible.every((r) => names.includes(r.name));

  const act = (r: AppRow, what: 'start' | 'stop' | 'restart') =>
    startTransition(async () => {
      const res =
        what === 'restart'
          ? await restartAppAction(r.name)
          : await updateAppAction(r.name, {
              instanceCount: what === 'stop' ? 0 : 1,
            });
      if (!res.ok) return void toast.error(res.error);
      toast.success(
        what === 'restart'
          ? `Restarting ${nameOf(r)}`
          : what === 'stop'
            ? `Stopping ${nameOf(r)}`
            : `Starting ${nameOf(r)}`,
      );
      router.refresh();
    });

  const menu = (r: AppRow) => {
    const extra = extraMenu?.(r, () => router.refresh());
    return (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label={`Actions for ${nameOf(r)}`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <Link href={`/apps/${r.name}`}>
              <Boxes className="h-4 w-4" /> Open {noun}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/apps/${r.name}/logs`}>
              <ScrollText className="h-4 w-4" /> View logs
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {r.instanceCount > 0 ? (
            <>
              <DropdownMenuItem
                disabled={r.version === 0 && !r.project}
                onSelect={() => act(r, 'restart')}
              >
                <RotateCw className="h-4 w-4" /> Restart
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => act(r, 'stop')}>
                <Square className="h-4 w-4" /> Stop
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => act(r, 'start')}>
              <Play className="h-4 w-4" /> Start
            </DropdownMenuItem>
          )}
          {extra && (
            <>
              <DropdownMenuSeparator />
              {extra}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const reading = (r: AppRow) => {
    const u = usage.data?.[r.name];
    return u
      ? `${u.cpuPercent.toFixed(u.cpuPercent < 10 ? 1 : 0)}% · ${formatBytes(u.memoryBytes)}`
      : '–';
  };
  const version = (r: AppRow) =>
    r.version > 0
      ? `v${r.version}${r.lastDeployed ? ` · ${timeAgo(r.lastDeployed)}` : ''}`
      : 'never deployed';
  const icons = (r: AppRow) => (
    <>
      {r.persistent && (
        <Database
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-label="Keeps data on a volume"
        />
      )}
      {r.customDomainsOnly && (
        <Globe
          className="h-3.5 w-3.5 text-muted-foreground"
          aria-label="Served only at its custom domains"
        />
      )}
    </>
  );
  const subtitle = (r: AppRow) => {
    const s = subtitleOf?.(r);
    return s ? (
      <p className="truncate font-mono text-xs text-muted-foreground">{s}</p>
    ) : null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${noun}s`}
            aria-label={`Search ${noun}s`}
            className="pl-8"
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Combobox
            value={filter}
            onValueChange={(v) => setFilterParam(v)}
            className="w-36"
            aria-label="Filter by status"
            options={FILTERS.map((f) => ({
              value: f,
              label: f === 'all' ? 'All statuses' : f,
            }))}
          />
          <Combobox
            value={sort}
            onValueChange={(v) => setSort(v as SortKey)}
            className="w-48"
            aria-label="Sort by"
            options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
              value: k,
              label: SORT_LABEL[k],
            }))}
          />
          <div className="inline-flex rounded-md border p-0.5">
            {(
              [
                ['list', List, 'List view'],
                ['grid', LayoutGrid, 'Grid view'],
              ] as const
            ).map(([v, Icon, label]) => (
              <Button
                key={v}
                variant={view === v ? 'outline' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                aria-label={label}
                aria-pressed={view === v}
                onClick={() => chooseView(v)}
              >
                <Icon className="h-4 w-4" />
              </Button>
            ))}
          </div>
        </div>
      </div>

      {bulk && names.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-secondary/30 px-3 py-2 text-sm">
          <span>{names.length} selected</span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => bulk.run(names, () => setTicked([]))}
          >
            {bulk.icon} {bulk.label}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTicked([])}>
            Clear
          </Button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          No {noun} matches.
        </p>
      ) : view === 'list' ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b bg-secondary/30 text-left text-xs text-muted-foreground">
                {bulk && (
                  <th className="w-10 pl-4">
                    <Checkbox
                      aria-label={`Select every ${noun}`}
                      checked={allTicked}
                      onCheckedChange={(on) =>
                        setTicked(on === true ? visible.map((r) => r.name) : [])
                      }
                    />
                  </th>
                )}
                <th className="px-4 py-2.5 font-medium capitalize">{noun}</th>
                <th className="w-32 px-4 py-2.5 font-medium">Status</th>
                <th className="hidden w-60 px-4 py-2.5 font-medium md:table-cell">
                  Address
                </th>
                <th className="hidden w-36 px-4 py-2.5 font-medium lg:table-cell">
                  Usage
                </th>
                <th className="hidden w-36 px-4 py-2.5 font-medium lg:table-cell">
                  Version
                </th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((r) => (
                <tr
                  key={r.name}
                  className="cursor-pointer hover:bg-secondary/30"
                  onClick={() => router.push(`/apps/${r.name}`)}
                >
                  {bulk && (
                    <td
                      className="w-10 pl-4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        aria-label={`Select ${nameOf(r)}`}
                        checked={names.includes(r.name)}
                        onCheckedChange={(on) => tick(r.name, on === true)}
                      />
                    </td>
                  )}
                  <td className="overflow-hidden px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/apps/${r.name}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {nameOf(r)}
                      </Link>
                      <UpgradeBadge
                        app={r.name}
                        image={r.image}
                        update={r.update}
                        persistent={r.persistent}
                        project={r.project}
                      />
                      {icons(r)}
                    </div>
                    {subtitle(r)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill row={r} />
                  </td>
                  <td className="hidden max-w-[17rem] px-4 py-3 md:table-cell">
                    <Address row={r} />
                  </td>
                  <td className="hidden px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground lg:table-cell">
                    {reading(r)}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground lg:table-cell">
                    {version(r)}
                  </td>
                  <td className="px-2 py-3">{menu(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((r) => {
            const status = statusOf(r);
            const u = usage.data?.[r.name];
            return (
              <div
                key={r.name}
                className="flex cursor-pointer flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-secondary/30"
                onClick={() => router.push(`/apps/${r.name}`)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      {bulk && (
                        <span onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            aria-label={`Select ${nameOf(r)}`}
                            checked={names.includes(r.name)}
                            onCheckedChange={(on) => tick(r.name, on === true)}
                          />
                        </span>
                      )}
                      {/* a running app is just a green dot: only a state that needs a look gets words */}
                      <span
                        title={status}
                        aria-label={status}
                        className={cn(
                          'h-2.5 w-2.5 shrink-0 rounded-full',
                          DOT[status],
                        )}
                      />
                      <Link
                        href={`/apps/${r.name}`}
                        className="truncate font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {nameOf(r)}
                      </Link>
                      <UpgradeBadge
                        app={r.name}
                        image={r.image}
                        update={r.update}
                        persistent={r.persistent}
                        project={r.project}
                      />
                      {icons(r)}
                      {status !== 'running' && (
                        <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {status}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate pl-[18px] font-mono text-xs text-muted-foreground">
                      {r.image ? shortImage(r.image) : 'nothing deployed yet'}
                    </p>
                  </div>
                  {menu(r)}
                </div>
                <div className="pl-[18px] text-sm">
                  <Address row={r} />
                </div>
                <div className="mt-auto grid grid-cols-3 gap-3 border-t pt-3 text-xs">
                  <Fact label="Instances">
                    {r.instanceCount === 0 ? '–' : r.instanceCount}
                  </Fact>
                  <Fact label="CPU">
                    {u ? (
                      <span className="flex flex-col gap-1">
                        <span className="tabular-nums">
                          {u.cpuPercent.toFixed(u.cpuPercent < 10 ? 1 : 0)}%
                        </span>
                        <span className="h-1 overflow-hidden rounded-full bg-secondary">
                          <span
                            className="block h-full rounded-full bg-primary/70"
                            style={{
                              width: `${Math.min(100, Math.max(2, u.cpuPercent))}%`,
                            }}
                          />
                        </span>
                      </span>
                    ) : (
                      '–'
                    )}
                  </Fact>
                  <Fact label="Memory">
                    {u ? formatBytes(u.memoryBytes) : '–'}
                  </Fact>
                </div>
                <p className="-mt-1 text-xs text-muted-foreground">
                  {version(r)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
