'use client';

import {
  AlertTriangle,
  Check,
  History,
  KeyRound,
  Loader2,
  RefreshCw,
  User,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  ACTION_GROUPS,
  activityQuery,
  detailOf,
  failureText,
  groupByDay,
  renamedTo,
  wordsFor,
  type ActivityActor,
  type ActivityEvent,
  type ActivityFilters,
  type ActivityPage,
} from '@/lib/activity';
import { apiGet } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all';

export function ActivityView({
  initial,
  filters,
  apps,
}: {
  initial: ActivityPage;
  filters: ActivityFilters;
  apps: string[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState(initial.events);
  const [next, setNext] = useState(initial.next);
  const [error, setError] = useState<string>();
  const [loading, startLoading] = useTransition();
  const [refreshing, startRefresh] = useTransition();

  const filtered = Object.values(filters).some(Boolean);
  const change = (patch: Partial<ActivityFilters>) => {
    const merged = { ...filters, ...patch };
    const q = activityQuery(merged);
    router.replace(`/settings/activity${q ? `?${q}` : ''}`);
  };

  const older = () =>
    startLoading(async () => {
      setError(undefined);
      try {
        const page = await apiGet<ActivityPage>(
          `activity?${activityQuery(filters, { before: next })}`,
        );
        setEvents((e) => [...e, ...page.events]);
        setNext(page.next);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load more');
      }
    });

  // An app named in the address is offered even when it is gone (its history stays)
  const appOptions = [
    ...(filters.app && !apps.includes(filters.app) ? [filters.app] : []),
    ...apps,
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Combobox
          aria-label="App"
          searchable
          className="w-44"
          value={filters.app ?? ALL}
          onValueChange={(v) => change({ app: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'All apps' },
            ...appOptions.map((a) => ({ value: a, label: a })),
          ]}
        />
        <Combobox
          aria-label="What changed"
          className="w-40"
          value={filters.action ?? ALL}
          onValueChange={(v) => change({ action: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Everything' },
            ...ACTION_GROUPS.map((g) => ({ value: g.id, label: g.label })),
          ]}
        />
        <Combobox
          aria-label="Who"
          searchable
          className="w-36"
          value={filters.actor ?? ALL}
          onValueChange={(v) => change({ actor: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Anyone' },
            ...[
              ...(filters.actor && !initial.actors.includes(filters.actor)
                ? [filters.actor]
                : []),
              ...initial.actors,
            ].map((a) => ({ value: a, label: a === 'admin' ? 'Admin' : a })),
          ]}
        />
        <Combobox
          aria-label="Outcome"
          className="w-36"
          value={filters.outcome ?? ALL}
          onValueChange={(v) =>
            change({ outcome: v === ALL ? undefined : (v as 'ok' | 'failed') })
          }
          options={[
            { value: ALL, label: 'Any outcome' },
            { value: 'ok', label: 'Worked' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Refresh"
          title="Refresh"
          disabled={refreshing}
          onClick={() => startRefresh(() => router.refresh())}
        >
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
        </Button>
      </div>

      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
          <History className="h-7 w-7 text-muted-foreground" />
          {filtered ? (
            <>
              <p className="font-medium">No changes match these filters</p>
              <p className="text-sm text-muted-foreground">
                Nothing was recorded for that combination yet.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.replace('/settings/activity')}
              >
                Clear the filters
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium">Nothing has changed yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Deploys, restarts, new variables, domains and the rest show up
                here as they happen, with who did them.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groupByDay(events).map((day) => (
            <section key={day.label} aria-label={day.label}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {day.label}
              </h3>
              <ol className="divide-y rounded-xl border bg-card">
                {day.events.map((e) => (
                  <EventRow key={e.id} e={e} />
                ))}
              </ol>
            </section>
          ))}
          <div className="flex flex-col items-center gap-2">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {next !== null ? (
              <Button variant="outline" onClick={older} disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Load older
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                That is everything the log still holds.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const ACTOR_ICON = { admin: User, token: KeyRound, ci: Workflow } as const;

function Actor({ actor }: { actor: ActivityActor }) {
  const Icon = ACTOR_ICON[actor.kind];
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      <Icon
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
      {actor.kind === 'admin' ? 'Admin' : actor.name}
      {actor.kind !== 'admin' && (
        <span className="rounded bg-secondary px-1 py-px text-[10px] font-normal text-muted-foreground">
          {actor.kind === 'ci' ? 'deploy key' : `${actor.scope} token`}
        </span>
      )}
    </span>
  );
}

function EventRow({ e }: { e: ActivityEvent }) {
  const { verb, href } = wordsFor(e);
  const detail = detailOf(e);
  const renamed = renamedTo(e);
  const failed = e.outcome === 'failed';
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          failed
            ? 'bg-destructive/15 text-red-700 dark:text-destructive'
            : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        )}
        title={failed ? failureText(e.status) : 'Worked'}
      >
        {failed ? (
          <AlertTriangle className="h-3 w-3" />
        ) : (
          <Check className="h-3 w-3" />
        )}
        <span className="sr-only">{failed ? 'Failed' : 'Worked'}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">
          <Actor actor={e.actor} /> {verb}
          {e.target &&
            (href ? (
              <>
                {' '}
                <Link
                  href={href}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {e.target}
                </Link>
              </>
            ) : (
              <span className="font-medium"> {e.target}</span>
            ))}
        </p>
        {renamed ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            now{' '}
            <Link
              href={`/apps/${encodeURIComponent(renamed)}`}
              className="font-mono underline-offset-4 hover:underline"
            >
              {renamed}
            </Link>
          </p>
        ) : (
          detail && (
            <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">
              {detail}
            </p>
          )
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <time
          dateTime={e.at}
          title={new Date(e.at).toLocaleString()}
          className="text-xs text-muted-foreground"
        >
          {timeAgo(e.at)}
        </time>
        {failed && <Badge variant="destructive">{failureText(e.status)}</Badge>}
      </div>
    </li>
  );
}
