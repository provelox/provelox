'use client';

import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Cpu,
  MemoryStick,
  Play,
  Square,
} from 'lucide-react';
import Link from 'next/link';
import type { UsageByApp } from '@/lib/backend';
import { formatBytes, formatMachineRam } from '@/lib/format';
import { updateLabel } from '@/lib/image-updates';
import {
  KpiBar,
  KpiIcon,
  kpiFigure,
  kpiSurface,
  type KpiTone,
} from '@/components/ui/kpi';
import { cn } from '@/lib/utils';
import { statusOf, type AppRow, type AppStatus } from './app-row';

type Tile = {
  id: string;
  label: string;
  value: string;
  hint?: string;
  icon: typeof Play;
  tone: KpiTone;
  /** A share to draw under the figure, 0 to 100 */
  bar?: number;
  /** What clicking narrows the list to */
  filter?: { status?: AppStatus | 'all'; updates?: boolean };
  active?: boolean;
};

/**
 * What needs a look, before the list: how many run, how many are stopped, what is failing, which apps have a newer
 * image, and what the fleet uses. Each tile narrows the list to those apps.
 */
export function FleetSummary({
  rows,
  usage,
  capacity,
  status,
  updatesOnly,
  onFilter,
}: {
  rows: AppRow[];
  usage?: UsageByApp;
  capacity?: { cpus: number; memoryBytes: number };
  status: string;
  updatesOnly: boolean;
  onFilter: (f: { status?: AppStatus | 'all'; updates?: boolean }) => void;
}) {
  const by = (s: AppStatus) => rows.filter((r) => statusOf(r) === s);
  const running = by('running');
  const stopped = by('stopped');
  const trouble = rows.filter((r) =>
    ['failed', 'unhealthy'].includes(statusOf(r)),
  );
  const updates = rows.filter((r) => updateLabel(r.update) !== null);
  const readings = Object.values(usage ?? {});
  const cpu = readings.reduce((n, u) => n + u.cpuPercent, 0);
  const mem = readings.reduce((n, u) => n + u.memoryBytes, 0);

  // Docker reports CPU per core (100% is one core), so a share of the machines is the sum over all their cores
  const memShare = capacity?.memoryBytes
    ? (mem / capacity.memoryBytes) * 100
    : 0;
  const cpuShare = capacity?.cpus ? cpu / capacity.cpus : 0;

  const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;

  const tiles: Tile[] = [
    {
      id: 'running',
      label: 'Running',
      value: String(running.length),
      hint: `of ${rows.length} app${rows.length === 1 ? '' : 's'}`,
      icon: Play,
      tone: 'good',
      bar: rows.length ? (running.length / rows.length) * 100 : 0,
      filter: { status: 'running' },
      active: status === 'running' && !updatesOnly,
    },
    {
      id: 'stopped',
      label: 'Stopped',
      value: String(stopped.length),
      hint: stopped.length ? 'not running' : 'none',
      icon: Square,
      tone: 'neutral',
      filter: { status: 'stopped' },
      active: status === 'stopped' && !updatesOnly,
    },
    {
      id: 'trouble',
      label: 'Needs attention',
      value: String(trouble.length),
      hint: trouble.length ? 'failing or unhealthy' : 'all well',
      icon: AlertTriangle,
      tone: trouble.length ? 'bad' : 'neutral',
      filter: trouble.length
        ? { status: by('failed').length > 0 ? 'failed' : 'unhealthy' }
        : undefined,
      active: ['failed', 'unhealthy'].includes(status) && !updatesOnly,
    },
    {
      id: 'updates',
      label: 'Newer images',
      value: String(updates.length),
      hint: updates.length ? 'ready to roll out' : 'up to date',
      icon: ArrowUpCircle,
      tone: updates.length ? 'warn' : 'neutral',
      filter: updates.length ? { status: 'all', updates: true } : undefined,
      active: updatesOnly,
    },
    {
      id: 'memory',
      label: 'Memory in use',
      value: !readings.length
        ? '–'
        : capacity
          ? pct(memShare)
          : formatBytes(mem),
      hint: !readings.length
        ? 'no reading yet'
        : capacity
          ? `${formatBytes(mem)} of ${formatMachineRam(capacity.memoryBytes)}`
          : 'across all apps',
      icon: MemoryStick,
      tone: 'info',
      bar: readings.length && capacity ? Math.min(100, memShare) : undefined,
    },
    {
      id: 'cpu',
      label: 'Processor in use',
      value: !readings.length ? '–' : pct(capacity ? cpuShare : cpu),
      hint: !readings.length
        ? 'no reading yet'
        : capacity
          ? `of ${capacity.cpus} core${capacity.cpus === 1 ? '' : 's'}`
          : 'of one core, summed',
      icon: Cpu,
      tone: 'info',
      bar: readings.length && capacity ? Math.min(100, cpuShare) : undefined,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label="Fleet summary"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
      >
        {tiles.map((t) => {
          const body = (
            <>
              <span className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t.label}
                </span>
                <KpiIcon
                  icon={t.active ? Check : t.icon}
                  tone={t.tone}
                  solid={t.active}
                  className="h-6 w-6 rounded-md [&>svg]:h-3.5 [&>svg]:w-3.5"
                />
              </span>
              <span className="mt-1 flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-2xl font-semibold leading-none tabular-nums',
                    // a zero is not news: only a figure that means something takes its colour
                    Number(t.value) > 0 || t.id === 'memory' || t.id === 'cpu'
                      ? kpiFigure(t.tone)
                      : 'text-foreground',
                  )}
                >
                  {t.value}
                </span>
                {(t.active || t.hint) && (
                  <span className="truncate text-xs text-muted-foreground">
                    {t.active ? 'filtered' : t.hint}
                  </span>
                )}
              </span>
              {t.bar !== undefined && (
                <span className="mt-2 block">
                  <KpiBar value={t.bar} tone={t.tone} />
                </span>
              )}
            </>
          );
          const cls = cn(
            kpiSurface(
              t.tone === 'neutral' ||
                (t.tone !== 'good' &&
                  t.tone !== 'info' &&
                  Number(t.value) === 0)
                ? 'neutral'
                : t.tone,
              !!t.active,
            ),
            'flex flex-col p-3 text-left',
            t.filter && 'transition-all hover:-translate-y-px hover:shadow-md',
          );
          return t.filter ? (
            <button
              key={t.id}
              type="button"
              aria-pressed={!!t.active}
              title={
                t.active ? 'Showing only these. Click to clear.' : undefined
              }
              onClick={() => onFilter(t.active ? { status: 'all' } : t.filter!)}
              className={cls}
            >
              {body}
            </button>
          ) : (
            <div key={t.id} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
      {trouble.length > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm"
        >
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
          <span className="font-medium">Look at</span>
          {trouble.slice(0, 6).map((r) => (
            <Link
              key={r.name}
              href={`/apps/${r.name}/logs`}
              className="underline-offset-2 hover:underline"
              title={`${r.name} is ${statusOf(r)}: open its logs`}
            >
              {r.name}
            </Link>
          ))}
          {trouble.length > 6 && (
            <span className="text-muted-foreground">
              +{trouble.length - 6} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
