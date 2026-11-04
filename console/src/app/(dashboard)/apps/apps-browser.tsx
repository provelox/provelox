'use client';

import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Database,
  ExternalLink,
  Library,
  LibraryBig,
  Globe,
  Layers,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCw,
  Square,
  Pin,
  Plus,
  ScrollText,
  Search,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { UpgradeBadge } from '@/components/apps/upgrade-badge';
import { GroupAppsDialog } from '@/components/projects/group-apps';
import { useRouter } from 'next/navigation';
import { useUrlState } from '@/lib/url-state';
import { useFavorites } from '@/lib/use-favorites';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  deleteAppAction,
  restartAppAction,
  updateAppAction,
} from '@/actions/apps';
import {
  createGroupAction,
  deleteGroupAction,
  moveAppToGroupAction,
  renameGroupAction,
} from '@/actions/groups';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import dynamic from 'next/dynamic';
import { useEver } from '@/lib/use-ever';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { apiGet } from '@/lib/client-api';
import { formatBytes, timeAgo } from '@/lib/format';
import type { UsageByApp } from '@/lib/backend';
import { partition, type GroupsFile } from '@/lib/groups';
import { cn } from '@/lib/utils';
import {
  SORT_LABEL,
  sameRow,
  sortRows,
  statusOf,
  type AppRow,
  type AppStatus,
  type SortKey,
} from './app-row';
import { BulkBar } from './bulk-bar';
import { BULK_LABEL, planBulk, summarizeBulk, type BulkAction } from './bulk';
import { GroupNameDialog } from './group-name-dialog';
import { FleetSummary } from './fleet-summary';
import { NewAppDialog } from './new-app-dialog';

// Dialogs nobody needs until they open one are fetched then, not with the list
const TidyNamesDialog = dynamic(
  () => import('./tidy-names-dialog').then((m) => m.TidyNamesDialog),
  { ssr: false },
);
const RemoveProjectDialog = dynamic(
  () =>
    import('@/components/projects/remove-project-dialog').then(
      (m) => m.RemoveProjectDialog,
    ),
  { ssr: false },
);
import { updateLabel } from '@/lib/image-updates';
import { useHeld } from '@/lib/use-held';

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
type Dialog =
  | { kind: 'new' }
  | { kind: 'new-for-app'; app: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string; name: string; count: number }
  | { kind: 'delete-app'; name: string }
  | null;

const USAGE_KEY = ['usage-all'];
const fetchUsage = () => apiGet<UsageByApp>('usage');

const COLLAPSED_KEY = 'provelox:apps:collapsed';
const SORT_KEY = 'provelox:apps:sort';

function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v && v in SORT_LABEL ? (v as SortKey) : 'name';
  } catch {
    return 'name';
  }
}
const DOT: Record<AppStatus, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500 animate-pulse',
  failed: 'bg-red-500',
  stopped: 'bg-muted-foreground/50',
  unhealthy: 'bg-red-500 animate-pulse',
  building: 'bg-amber-500 animate-pulse',
};

function readCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A function that never changes identity but always runs the latest closure. The rows are memoised, so what they are
 * handed must stay the same between renders; the work behind it still sees the current state.
 */
function useStable<A extends unknown[], R>(fn: (...args: A) => R) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}

function matchesQuery(r: AppRow, groupName: string, q: string) {
  if (!q) return true;
  const hay = [r.name, groupName, ...r.domains.map((d) => d.host)]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

export function AppsBrowser({
  rows,
  groups,
  rootDomain,
  defaultSubdomain,
  capacity,
}: {
  rows: AppRow[];
  groups: GroupsFile;
  rootDomain: string;
  defaultSubdomain: boolean;
  /** What the machines have, when known */
  capacity?: { cpus: number; memoryBytes: number };
}) {
  const router = useRouter();
  // The search and the status filter live in the address, so they are still there when you come back to the list
  const [query, setQuery] = useUrlState('q');
  const [filterParam, setFilterParam] = useUrlState('status', 'all');
  const filter: Filter = FILTERS.includes(filterParam as Filter)
    ? (filterParam as Filter)
    : 'all';
  const setFilter = (f: Filter) => setFilterParam(f);
  // narrowed to the apps with a newer image (the summary's tile)
  const [updatesParam, setUpdatesParam] = useUrlState('updates');
  const updatesOnly = updatesParam === '1';
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [removingProject, setRemovingProject] = useState<string | null>(null);
  const shownRemoving = useHeld(removingProject);
  // Apps being moved into a project
  const [grouping, setGrouping] = useState<string[] | null>(null);
  const [tidying, setTidying] = useState(false);
  // Selecting several apps to act on together
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{
    action: BulkAction;
    groupId?: string | null;
  } | null>(null);
  const [typedApp, setTypedApp] = useState('');
  // How the list is ordered is remembered in this browser
  const [sort, setSort] = useState<SortKey>('name');
  // What each running app uses, refreshed while the list is open (not in a background tab)
  const usage = useQuery({
    queryKey: USAGE_KEY,
    queryFn: fetchUsage,
    enabled: rows.some((r) => r.instanceCount > 0),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const [serverError, setServerError] = useState<string>();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setCollapsed(readCollapsed());
    setSort(readSort());
  }, []);

  const chooseSort = (k: SortKey) => {
    setSort(k);
    try {
      localStorage.setItem(SORT_KEY, k);
    } catch {
      // remembering the order is a convenience only
    }
  };

  const toggle = (id: string) =>
    setCollapsed((cur) => {
      const next = cur.includes(id)
        ? cur.filter((x) => x !== id)
        : [...cur, id];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // remembering the fold state is a convenience only
      }
      return next;
    });

  // Every section that can fold: the groups and the projects. One control folds or unfolds them all.
  const sectionIds = useMemo(
    () => [
      ...groups.groups.map((g) => g.id),
      ...[...new Set(rows.flatMap((r) => (r.project ? [r.project] : [])))].map(
        (p) => `project:${p}`,
      ),
    ],
    [groups, rows],
  );
  const allCollapsed =
    sectionIds.length > 0 && sectionIds.every((id) => collapsed.includes(id));
  const toggleAll = () =>
    setCollapsed(() => {
      const next = allCollapsed ? [] : sectionIds;
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // remembering the fold state is a convenience only
      }
      return next;
    });

  const groupOf = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const g of groups.groups)
      for (const n of g.appNames) if (!m.has(n)) m.set(n, g);
    return m;
  }, [groups]);

  const counts = useMemo(() => {
    const c = {
      all: rows.length,
      running: 0,
      starting: 0,
      failed: 0,
      stopped: 0,
      unhealthy: 0,
      building: 0,
    };
    for (const r of rows) c[statusOf(r)]++;
    return c;
  }, [rows]);

  // The box answers at once; the list follows when React has a moment, so typing never waits on a long list
  const q = useDeferredValue(query.trim());
  const filtering = q !== '' || filter !== 'all' || updatesOnly;
  // The readings only decide the order when the list is sorted by them: a poll must not re-sort anything otherwise
  const usageForSort =
    sort === 'cpu' || sort === 'memory' ? usage.data : undefined;
  const visible = useMemo(
    () =>
      sortRows(
        rows
          .filter((r) => filter === 'all' || statusOf(r) === filter)
          .filter((r) => !updatesOnly || updateLabel(r.update) !== null)
          .filter((r) => matchesQuery(r, groupOf.get(r.name)?.name ?? '', q)),
        sort,
        usageForSort,
      ),
    [rows, filter, updatesOnly, q, groupOf, sort, usageForSort],
  );
  // Apps of a project (a template or a compose stack) are shown together as one stack, not as loose apps
  const stacks = useMemo(() => {
    const m = new Map<string, AppRow[]>();
    for (const r of visible)
      if (r.project) m.set(r.project, [...(m.get(r.project) ?? []), r]);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);
  // The rows go through unchanged (wrapped for the name `partition` wants), so a memoised row can tell that
  // nothing about it moved
  const toShow = useMemo(
    () =>
      partition(
        groups,
        visible
          .filter((r) => !r.project)
          .map((row) => ({ appName: row.name, row })),
      ),
    [groups, visible],
  );
  // the empty-group sections still show when nothing is being filtered
  const sections = toShow.groups.filter((s) => !filtering || s.apps.length > 0);
  const hasGroups = groups.groups.length > 0;
  // Who is in each collection, by lookup and not by searching a list for every row
  const inGroup = useMemo(() => {
    const m = new Map<string, AppRow[]>();
    for (const g of groups.groups) {
      const names = new Set(g.appNames);
      m.set(
        g.id,
        rows.filter((r) => names.has(r.name)),
      );
    }
    return m;
  }, [groups, rows]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const tidyEver = useEver(tidying);
  const removeEver = useEver(removingProject !== null);

  const run = (
    work: () => Promise<{ ok: boolean; error?: string }>,
    done: string,
    onOk?: () => void,
  ) =>
    startTransition(async () => {
      const res = await work();
      if (!res.ok) {
        setServerError(res.error);
        toast.error(res.error ?? 'Something went wrong');
        return;
      }
      setServerError(undefined);
      setDialog(null);
      toast.success(done);
      onOk?.();
      router.refresh();
    });

  const move = (app: string, groupId: string | null) =>
    run(
      () => moveAppToGroupAction(app, groupId),
      groupId === null ? `Removed ${app} from its group` : `Moved ${app}`,
    );

  const setChecked = (names: string[], on: boolean) =>
    setSelected((cur) =>
      on
        ? [...new Set([...cur, ...names])]
        : cur.filter((n) => !names.includes(n)),
    );
  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
  };
  const selectedRows = rows.filter((r) => selected.includes(r.name));
  const bulkPlan = bulk ? planBulk(bulk.action, selectedRows) : null;
  // the confirm dialog keeps its text while it fades out (leaving selection mode empties both)
  const shownBulk = useHeld(bulk);
  const shownPlan = useHeld(bulkPlan);

  /** Runs the action on each app, a few at a time so Docker is not asked to do everything at once. */
  const runBulk = () => {
    if (!bulk || !bulkPlan) return;
    const { action, groupId } = bulk;
    const targets = bulkPlan.apply;
    startTransition(async () => {
      const one = async (r: AppRow) => {
        const res =
          action === 'restart'
            ? await restartAppAction(r.name)
            : action === 'stop'
              ? await updateAppAction(r.name, { instanceCount: 0 })
              : action === 'start'
                ? await updateAppAction(r.name, { instanceCount: 1 })
                : await moveAppToGroupAction(r.name, groupId ?? null);
        return { name: r.name, error: res.ok ? undefined : res.error };
      };
      const outcomes: { name: string; error?: string }[] = [];
      for (let i = 0; i < targets.length; i += 4)
        outcomes.push(...(await Promise.all(targets.slice(i, i + 4).map(one))));
      const failed = outcomes.some((o) => o.error);
      (failed ? toast.error : toast.success)(summarizeBulk(action, outcomes));
      setBulk(null);
      stopSelecting();
      router.refresh();
    });
  };

  // What a row can do, each taking the app it is for, so the same functions serve every row (and the rows, being
  // memoised, are not redrawn when something else on the page changes)
  const rowActions = {
    onCheck: useStable((name: string, on: boolean) => setChecked([name], on)),
    onMove: useStable((name: string, id: string | null) => move(name, id)),
    onNewGroup: useStable((name: string) => {
      setServerError(undefined);
      setDialog({ kind: 'new-for-app', app: name });
    }),
    onDelete: useStable((name: string) => {
      setTypedApp('');
      setDialog({ kind: 'delete-app', name });
    }),
    onRemoveProject: useStable((project: string) =>
      setRemovingProject(project),
    ),
    onGroup: useStable((name: string) => setGrouping([name])),
    onStart: useStable((name: string) =>
      run(() => updateAppAction(name, { instanceCount: 1 }), `Started ${name}`),
    ),
    onStop: useStable((name: string) =>
      run(() => updateAppAction(name, { instanceCount: 0 }), `Stopped ${name}`),
    ),
    onRestart: useStable((name: string) =>
      run(() => restartAppAction(name), `Restarting ${name}`),
    ),
  };

  const renderRow = (r: AppRow) => (
    <AppRowView
      key={r.name}
      row={r}
      selecting={selecting}
      checked={selectedSet.has(r.name)}
      groupId={groupOf.get(r.name)?.id ?? null}
      groups={groups}
      {...rowActions}
    />
  );

  // The dialog is always the second child of a fragment, so it keeps its state when the page switches between
  // this empty state and the list (creating the very first app does exactly that)
  if (rows.length === 0 && !hasGroups)
    return (
      <>
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <Boxes className="h-8 w-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No apps yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first app, a short guided flow takes you from a name
              to a running deploy.
            </p>
          </div>
          <Button asChild size="sm">
            <Link href="/apps?new=1">
              <Plus className="h-4 w-4" /> New app
            </Link>
          </Button>
        </Card>
        <NewAppDialog
          existingApps={[]}
          groups={groups}
          rootDomain={rootDomain}
          defaultSubdomain={defaultSubdomain}
        />
      </>
    );

  return (
    <>
      <div className="flex flex-col gap-4">
        <FleetSummary
          rows={rows}
          usage={usage.data}
          capacity={capacity}
          status={filter}
          updatesOnly={updatesOnly}
          onFilter={(f) => {
            setFilter((f.status ?? 'all') as Filter);
            setUpdatesParam(f.updates ? '1' : '');
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, domain or group"
              aria-label="Filter apps"
              className="pl-9"
            />
          </div>
          <div
            role="group"
            aria-label="Filter by status"
            className="flex rounded-md border p-0.5 text-sm"
          >
            {(
              [
                ['all', 'All'],
                ['running', 'Running'],
                ['starting', 'Starting'],
                ['failed', 'Failing'],
                ['unhealthy', 'Unhealthy'],
                ['stopped', 'Stopped'],
                ['building', 'Building'],
              ] as const
            )
              .filter(([k]) => k === 'all' || k === filter || counts[k] > 0)
              .map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={filter === k}
                  onClick={() => setFilter(k)}
                  className={cn(
                    'rounded px-3 py-1 transition-colors',
                    filter === k
                      ? 'bg-secondary font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}{' '}
                  <span className="text-xs text-muted-foreground">
                    {counts[k]}
                  </span>
                </button>
              ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="sort" className="text-sm text-muted-foreground">
              Sort
            </label>
            <Combobox
              value={sort}
              onValueChange={(v) => chooseSort(v as SortKey)}
              id="sort"
              size="sm"
              className="w-48"
              options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
                value: k,
                label: SORT_LABEL[k],
              }))}
            />
          </div>
          {sectionIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={toggleAll}
              title={
                allCollapsed
                  ? 'Open every collection and project'
                  : 'Fold every collection and project'
              }
            >
              {allCollapsed ? (
                <ChevronsUpDown className="h-4 w-4" />
              ) : (
                <ChevronsDownUp className="h-4 w-4" />
              )}
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </Button>
          )}
          <Button
            variant={selecting ? 'default' : 'outline'}
            size="sm"
            aria-pressed={selecting}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
          >
            {selecting ? 'Done' : 'Select'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setServerError(undefined);
              setDialog({ kind: 'new' });
            }}
          >
            <LibraryBig className="h-4 w-4" /> New collection
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="More"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setTidying(true)}>
                <Pencil className="h-4 w-4" /> Tidy names…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {filtering && visible.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No apps match.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setQuery('');
                setFilter('all');
                setUpdatesParam('');
              }}
            >
              Clear filters
            </button>
          </Card>
        )}

        {sections.map(({ group, apps }) => {
          const isOpen = filtering || !collapsed.includes(group.id);
          const all = inGroup.get(group.id) ?? [];
          return (
            <Card key={group.id} className="overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2">
                {selecting && apps.length > 0 && (
                  <Checkbox
                    aria-label={`Select every app in ${group.name}`}
                    checked={apps.every((a) => selectedSet.has(a.appName))}
                    onCheckedChange={(on) =>
                      setChecked(
                        apps.map((a) => a.appName),
                        on === true,
                      )
                    }
                  />
                )}
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggle(group.id)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${group.name}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                  <Link
                    href={`/collections/${group.id}`}
                    title="Open the details page"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-secondary/60"
                  >
                    <Library className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate font-medium">{group.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {all.length} app{all.length === 1 ? '' : 's'}
                    </span>
                    <span className="ml-2 hidden items-center gap-1 sm:flex">
                      {all.slice(0, 12).map((r) => (
                        <span
                          key={r.name}
                          title={`${r.name}: ${statusOf(r)}`}
                          className={cn(
                            'h-2 w-2 rounded-full',
                            DOT[statusOf(r)],
                          )}
                        />
                      ))}
                    </span>
                  </Link>
                </div>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for group ${group.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/collections/${group.id}`}>
                        <Library className="h-4 w-4" /> Open collection
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={`/apps?new=1&group=${group.id}`}>
                        <Plus className="h-4 w-4" /> New app in this collection
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setServerError(undefined);
                        setDialog({
                          kind: 'rename',
                          id: group.id,
                          name: group.name,
                        });
                      }}
                    >
                      <Pencil className="h-4 w-4" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        setDialog({
                          kind: 'delete',
                          id: group.id,
                          name: group.name,
                          count: all.length,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" /> Delete collection
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {isOpen && (
                <div className="divide-y border-t">
                  {apps.length === 0 ? (
                    <p className="px-4 py-5 text-sm text-muted-foreground">
                      No apps in this collection yet. Use{' '}
                      <span className="font-medium">Move to collection</span> on
                      an app, or{' '}
                      <Link
                        href={`/apps?new=1&group=${group.id}`}
                        className="underline"
                      >
                        create one here
                      </Link>
                      .
                    </p>
                  ) : (
                    apps.map((a) => renderRow(a.row))
                  )}
                </div>
              )}
            </Card>
          );
        })}

        {stacks.map(([project, apps]) => {
          const id = `project:${project}`;
          const isOpen = filtering || !collapsed.includes(id);
          return (
            <Card key={id} className="overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2">
                {selecting && (
                  <Checkbox
                    aria-label={`Select every app in ${project}`}
                    checked={apps.every((r) => selectedSet.has(r.name))}
                    onCheckedChange={(on) =>
                      setChecked(
                        apps.map((r) => r.name),
                        on === true,
                      )
                    }
                  />
                )}
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${project}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                  <Link
                    href={`/projects/${project}`}
                    title="Open the details page"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-secondary/60"
                  >
                    <Layers className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate font-medium">{project}</span>
                    <Badge>project</Badge>
                    <span className="text-xs text-muted-foreground">
                      {apps.length} service{apps.length === 1 ? '' : 's'}
                    </span>
                    {(() => {
                      const read = apps
                        .map((r) => usage.data?.[r.name])
                        .filter((u): u is NonNullable<typeof u> => !!u);
                      if (read.length === 0) return null;
                      const cpu = read.reduce((n, u) => n + u.cpuPercent, 0);
                      const mem = read.reduce((n, u) => n + u.memoryBytes, 0);
                      return (
                        <span
                          className="ml-1 hidden text-xs tabular-nums text-muted-foreground md:inline"
                          title="CPU and memory of the whole project now"
                        >
                          {cpu.toFixed(cpu < 10 ? 1 : 0)}% · {formatBytes(mem)}
                        </span>
                      );
                    })()}
                    <span className="ml-2 hidden items-center gap-1 sm:flex">
                      {apps.map((r) => (
                        <span
                          key={r.name}
                          title={`${r.name}: ${statusOf(r)}`}
                          className={cn(
                            'h-2 w-2 rounded-full',
                            DOT[statusOf(r)],
                          )}
                        />
                      ))}
                    </span>
                  </Link>
                </div>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for project ${project}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/projects/${project}`}>
                        <Layers className="h-4 w-4" /> Open project
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setRemovingProject(project)}
                    >
                      <Trash2 className="h-4 w-4" /> Remove project…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {isOpen && (
                <div className="divide-y border-t">{apps.map(renderRow)}</div>
              )}
            </Card>
          );
        })}

        {toShow.ungrouped.length > 0 && (
          <Card className="overflow-hidden">
            {hasGroups && (
              <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm text-muted-foreground">
                <Boxes className="h-4 w-4" />
                <span className="font-medium text-foreground">
                  No collection
                </span>
                {toShow.ungrouped.length}
              </div>
            )}
            <div className="divide-y">
              {toShow.ungrouped.map((a) => renderRow(a.row))}
            </div>
          </Card>
        )}

        <GroupNameDialog
          open={dialog?.kind === 'new' || dialog?.kind === 'new-for-app'}
          onOpenChange={(o) => !o && setDialog(null)}
          title="New collection"
          description={
            dialog?.kind === 'new-for-app'
              ? `Create a collection and put ${dialog.app} in it.`
              : 'Collections hold the apps of one product, for example its API, site and portal.'
          }
          confirmLabel="Create collection"
          groups={groups}
          pending={pending}
          serverError={serverError}
          onSubmit={(name) => {
            const target = dialog?.kind === 'new-for-app' ? dialog.app : null;
            startTransition(async () => {
              const created = await createGroupAction(name);
              if (!created.ok || !created.data) {
                setServerError(
                  created.ok
                    ? 'Could not create the collection'
                    : created.error,
                );
                return;
              }
              if (target) {
                const moved = await moveAppToGroupAction(target, created.data);
                if (!moved.ok) {
                  toast.error(`Collection created, but ${moved.error}`);
                  setDialog(null);
                  router.refresh();
                  return;
                }
              }
              setServerError(undefined);
              setDialog(null);
              toast.success(
                target ? `Moved ${target} to ${name}` : `Created ${name}`,
              );
              router.refresh();
            });
          }}
        />
        <GroupNameDialog
          open={dialog?.kind === 'rename'}
          onOpenChange={(o) => !o && setDialog(null)}
          title="Rename collection"
          initialName={dialog?.kind === 'rename' ? dialog.name : ''}
          confirmLabel="Rename"
          groups={groups}
          exceptId={dialog?.kind === 'rename' ? dialog.id : undefined}
          pending={pending}
          serverError={serverError}
          onSubmit={(name) =>
            dialog?.kind === 'rename' &&
            run(() => renameGroupAction(dialog.id, name), 'Group renamed')
          }
        />
        <AlertDialog
          open={dialog?.kind === 'delete'}
          onOpenChange={(o) => !o && setDialog(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete the collection{' '}
                {dialog?.kind === 'delete' ? dialog.name : ''}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Only the collection goes away.{' '}
                {dialog?.kind === 'delete' && dialog.count > 0
                  ? `Its ${dialog.count} app${dialog.count === 1 ? '' : 's'} stay${dialog.count === 1 ? 's' : ''} exactly as they are and are no longer in a collection.`
                  : 'It has no apps.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  dialog?.kind === 'delete' &&
                  run(() => deleteGroupAction(dialog.id), 'Group deleted')
                }
              >
                Delete collection
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={dialog?.kind === 'delete-app'}
          onOpenChange={(o) => !o && setDialog(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {dialog?.kind === 'delete-app' ? dialog.name : ''}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                The app and its service are removed. Persistent volumes are
                kept, so data is not lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Input
              autoFocus
              value={typedApp}
              onChange={(e) => setTypedApp(e.target.value)}
              placeholder={`Type ${dialog?.kind === 'delete-app' ? dialog.name : ''} to confirm`}
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  dialog?.kind !== 'delete-app' || typedApp !== dialog.name
                }
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() =>
                  dialog?.kind === 'delete-app' &&
                  run(
                    () => deleteAppAction(dialog.name),
                    `Deleted ${dialog.name}`,
                  )
                }
              >
                Delete app
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <BulkBar
          selected={selectedRows}
          groups={groups}
          busy={pending}
          onRequest={(action, groupId) => {
            // Moving is easily undone and starting is harmless: do those straight away. Stopping and restarting ask.
            const plan = planBulk(action, selectedRows);
            if (plan.apply.length === 0) return;
            setBulk({ action, groupId });
          }}
          onClear={() => setSelected([])}
          onGroup={() =>
            setGrouping(
              selectedRows.filter((r) => !r.project).map((r) => r.name),
            )
          }
        />
        <GroupAppsDialog
          apps={grouping}
          projects={[
            ...new Set(rows.flatMap((r) => (r.project ? [r.project] : []))),
          ].sort()}
          onClose={() => {
            setGrouping(null);
            stopSelecting();
            router.refresh();
          }}
        />
        <AlertDialog
          open={bulk !== null}
          onOpenChange={(o) => !o && !pending && setBulk(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {shownBulk ? BULK_LABEL[shownBulk.action] : ''}{' '}
                {shownPlan?.apply.length} app
                {shownPlan?.apply.length === 1 ? '' : 's'}?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="flex flex-col gap-2">
                  <p className="font-mono text-xs">
                    {shownPlan?.apply.map((r) => r.name).join(', ')}
                  </p>
                  {shownBulk?.action === 'stop' && (
                    <p>
                      They become unavailable until started again. Data is kept.
                    </p>
                  )}
                  {shownBulk?.action === 'restart' && (
                    <p>
                      Each is replaced with a fresh instance; images and
                      settings do not change.
                    </p>
                  )}
                  {!!shownPlan?.skip.length && (
                    <p className="text-muted-foreground">
                      Left out:{' '}
                      {shownPlan.skip
                        .map(
                          (s) =>
                            `${s.name} (${s.reason.toLowerCase().replace(/\.$/, '')})`,
                        )
                        .join('; ')}
                      .
                    </p>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault();
                  runBulk();
                }}
              >
                {shownBulk ? BULK_LABEL[shownBulk.action] : ''}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {removeEver && (
          <RemoveProjectDialog
            project={shownRemoving ?? ''}
            services={rows
              .filter((r) => r.project === shownRemoving)
              .map((r) => r.name)}
            open={removingProject !== null}
            onOpenChange={(o) => !o && setRemovingProject(null)}
            onRemoved={() => router.refresh()}
          />
        )}
      </div>
      <NewAppDialog
        existingApps={rows.map((r) => r.name)}
        groups={groups}
        rootDomain={rootDomain}
        defaultSubdomain={defaultSubdomain}
      />
      {tidyEver && (
        <TidyNamesDialog
          open={tidying}
          onOpenChange={setTidying}
          rows={rows}
          groups={groups}
          rootDomain={rootDomain}
        />
      )}
    </>
  );
}

/**
 * CPU and memory of one app, right now. It reads its own figures from the shared poll, so when the readings move only
 * these few words are drawn again, not the row around them.
 */
const RowUsage = memo(function RowUsage({ name }: { name: string }) {
  const { data: usage } = useQuery({
    queryKey: USAGE_KEY,
    queryFn: fetchUsage,
    enabled: false, // the list's own query polls; this only listens
    select: (all) => all?.[name],
  });
  return (
    <span
      className="hidden w-28 text-right tabular-nums md:block"
      title="CPU and memory now"
    >
      {usage
        ? `${usage.cpuPercent.toFixed(usage.cpuPercent < 10 ? 1 : 0)}% · ${formatBytes(usage.memoryBytes)}`
        : ''}
    </span>
  );
});

const AppRowView = memo(
  function AppRowView({
    row: r,
    groupId,
    groups,
    onMove,
    onNewGroup,
    onDelete,
    onRemoveProject,
    onGroup,
    onStart,
    onStop,
    onRestart,
    selecting,
    checked,
    onCheck,
  }: {
    row: AppRow;
    /** Selection mode: a checkbox shows, so several apps can be acted on together */
    selecting: boolean;
    checked: boolean;
    onCheck: (name: string, on: boolean) => void;
    groupId: string | null;
    groups: GroupsFile;
    onMove: (name: string, groupId: string | null) => void;
    onNewGroup: (name: string) => void;
    /** Standalone apps only */
    onDelete: (name: string) => void;
    /** Apps of a project: removing one means removing the project */
    onRemoveProject: (project: string) => void;
    /** Standalone apps: move into a project, keeping their data */
    onGroup: (name: string) => void;
    onStart: (name: string) => void;
    onStop: (name: string) => void;
    onRestart: (name: string) => void;
  }) {
    const status = statusOf(r);
    const { pinned, toggle } = useFavorites();
    const first = r.domains[0];
    const siteUrl = first?.url;
    return (
      <div
        className={cn(
          // a row far off the screen is neither laid out nor painted until it comes near
          '[contain-intrinsic-size:auto_4.25rem] [content-visibility:auto]',
          'group flex items-center gap-3 px-4 py-3 hover:bg-secondary/30',
          checked && 'bg-secondary/40',
        )}
      >
        {selecting && (
          <Checkbox
            aria-label={`Select ${r.name}`}
            checked={checked}
            onCheckedChange={(on) => onCheck(r.name, on === true)}
          />
        )}
        <span
          title={status}
          aria-label={status}
          className={cn('h-2.5 w-2.5 shrink-0 rounded-full', DOT[status])}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/apps/${r.name}`}
              className="font-medium hover:underline"
            >
              {r.name}
            </Link>
            <UpgradeBadge
              app={r.name}
              image={r.image}
              update={r.update}
              persistent={r.persistent}
              project={r.project}
            />
            {r.persistent && (
              <span
                title="Keeps data on a volume"
                aria-label="Keeps data on a volume"
                className="inline-flex text-muted-foreground"
              >
                <Database className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            )}
            {r.customDomainsOnly && (
              <span
                title="Served only at its custom domains, not at a default address"
                aria-label="Served only at its custom domains, not at a default address"
                className="inline-flex text-muted-foreground"
              >
                <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {!r.exposed && <span>Not served over HTTP</span>}
            {r.exposed && r.domains.length === 0 && (
              <span>No public address</span>
            )}
            {r.domains.slice(0, 2).map((d) => (
              <a
                key={d.host}
                href={d.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {d.host} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
            {r.domains.length > 2 && <span>+{r.domains.length - 2} more</span>}
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-4 text-xs text-muted-foreground sm:flex">
          {status === 'building' ? (
            <Badge variant="warning">building</Badge>
          ) : status === 'stopped' ? (
            <Badge>stopped</Badge>
          ) : (
            <Badge variant="success">
              {r.instanceCount} instance{r.instanceCount > 1 ? 's' : ''}
            </Badge>
          )}
          <RowUsage name={r.name} />
          <span className="w-24 text-right">
            {r.version > 0 ? (
              <>
                v{r.version}
                {r.lastDeployed && <> · {timeAgo(r.lastDeployed)}</>}
              </>
            ) : (
              'never deployed'
            )}
          </span>
        </div>
        {/* Quick actions: on hover (or when focused), so the common ones are one click away */}
        <div className="hidden items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:flex">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Logs"
          >
            <Link
              href={`/apps/${r.name}/logs`}
              aria-label={`Logs of ${r.name}`}
            >
              <ScrollText className="h-4 w-4" />
            </Link>
          </Button>
          {r.instanceCount > 0 ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="Restart"
                aria-label={`Restart ${r.name}`}
                disabled={r.version === 0 && !r.project}
                onClick={() => onRestart(r.name)}
              >
                <RotateCw className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="Stop"
                aria-label={`Stop ${r.name}`}
                onClick={() => onStop(r.name)}
              >
                <Square className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Start"
              aria-label={`Start ${r.name}`}
              onClick={() => onStart(r.name)}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${r.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem asChild>
              <Link href={`/apps/${r.name}`}>
                <Boxes className="h-4 w-4" /> Open app
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/apps/${r.name}/logs`}>
                <ScrollText className="h-4 w-4" /> View logs
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toggle(r.name)}>
              <Pin className="h-4 w-4" />{' '}
              {pinned.includes(r.name)
                ? 'Unpin from sidebar'
                : 'Pin to sidebar'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {r.instanceCount > 0 ? (
              <>
                <DropdownMenuItem
                  disabled={r.version === 0 && !r.project}
                  onSelect={() => onRestart(r.name)}
                >
                  <RotateCw className="h-4 w-4" /> Restart
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onStop(r.name)}>
                  <Square className="h-4 w-4" /> Stop
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onSelect={() => onStart(r.name)}>
                <Play className="h-4 w-4" /> Start
              </DropdownMenuItem>
            )}
            {siteUrl && (
              <DropdownMenuItem asChild>
                <a href={siteUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="h-4 w-4" /> Open site
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {r.project ? (
              <>
                <DropdownMenuItem asChild>
                  <Link href={`/projects/${r.project}`}>
                    <Layers className="h-4 w-4" /> Open project {r.project}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onRemoveProject(r.project!)}
                >
                  <Trash2 className="h-4 w-4" /> Remove project…
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => onGroup(r.name)}>
                  <Layers className="h-4 w-4" /> Move into a project…
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Library className="h-4 w-4" /> Move to collection
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48">
                    <DropdownMenuRadioGroup
                      value={groupId ?? 'none'}
                      onValueChange={(v) =>
                        v !== (groupId ?? 'none') &&
                        onMove(r.name, v === 'none' ? null : v)
                      }
                    >
                      <DropdownMenuRadioItem value="none">
                        No group
                      </DropdownMenuRadioItem>
                      {[...groups.groups]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((g) => (
                          <DropdownMenuRadioItem key={g.id} value={g.id}>
                            {g.name}
                          </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onNewGroup(r.name)}>
                      <LibraryBig className="h-4 w-4" /> New collection…
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onDelete(r.name)}
                >
                  <Trash2 className="h-4 w-4" /> Delete app…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
  // The handlers are stable, so a row is redrawn only when what it shows changes
  (a, b) =>
    sameRow(a.row, b.row) &&
    a.groupId === b.groupId &&
    a.groups === b.groups &&
    a.selecting === b.selecting &&
    a.checked === b.checked &&
    a.onMove === b.onMove &&
    a.onCheck === b.onCheck,
);
