'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { kpiSurface } from '@/components/ui/kpi';
import type { AppUsage, UsageHistory } from '@/lib/backend';
import { apiGet } from '@/lib/client-api';
import { formatBytes } from '@/lib/format';
import { agoLabel, fillOf, RANGES, sparkline } from '@/lib/usage';
import { cn } from '@/lib/utils';

const POLL_MS = 5000;

function Line({ series, max }: { series: number[]; max?: number }) {
  const points = sparkline(series, 120, 28, max);
  if (!points) return <div className="h-7" aria-hidden />;
  return (
    <svg
      viewBox="0 0 120 28"
      className="h-7 w-full text-primary"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A bar for the share of a limit used. Its row is kept when there is no limit, so the tile does not change height. */
function Meter({ fill }: { fill: number | null }) {
  if (fill === null) return <div className="h-1" aria-hidden />;
  return (
    <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className={cn(
          'h-full rounded-full',
          fill > 0.9
            ? 'bg-destructive'
            : fill > 0.7
              ? 'bg-amber-500'
              : 'bg-primary',
        )}
        style={{ width: `${fill * 100}%` }}
      />
    </div>
  );
}

const bar = 'animate-pulse rounded bg-muted';

/**
 * The shape of one reading while it loads. Every row has the height it has once filled in (a figure, its label, the
 * meter's row, the trend, the peak), so the tile is the same size before and after and nothing below it moves.
 */
function ReadingSkeleton() {
  return (
    <div className="min-w-0" aria-hidden>
      <div className="flex h-7 items-center">
        <div className={`${bar} h-5 w-16`} />
      </div>
      <div className="flex h-4 items-center">
        <div className={`${bar} h-3 w-24`} />
      </div>
      <div className="h-1" />
      <div className={`${bar} h-7 w-full opacity-60`} />
      <div className="flex h-4 items-center">
        <div className={`${bar} h-2.5 w-14`} />
      </div>
    </div>
  );
}

/**
 * What the app uses right now, refreshed while the page is open, and how that looked over the last stretch. The trend
 * comes from the history the API keeps, so it is there on arrival and shows overnight changes too.
 */
export function UsageTile({
  appName,
  running,
}: {
  appName: string;
  /** Only a running app has anything to read */
  running: boolean;
}) {
  const [minutes, setMinutes] = useState<number>(60);
  const usage = useQuery({
    queryKey: ['usage', appName],
    queryFn: () => apiGet<AppUsage>(`usage/${appName}`),
    enabled: running,
    refetchInterval: POLL_MS,
    // Do not poll in a background tab
    refetchIntervalInBackground: false,
  });
  const history = useQuery({
    queryKey: ['usage-history', appName, minutes],
    queryFn: () =>
      apiGet<UsageHistory>(`usage/${appName}/history?minutes=${minutes}`),
    // Samples are taken every half minute, so there is nothing newer to ask for sooner
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  const d = usage.data;
  const cpuSeries = history.data?.points.map((p) => p.cpu) ?? [];
  const memSeries = history.data?.points.map((p) => p.mem) ?? [];
  const cpuFill = d ? fillOf(d.cpuPercent, d.cpuLimitPercent) : null;
  const memFill = d ? fillOf(d.memoryBytes, d.memoryLimitBytes) : null;
  const cpuPeak = cpuSeries.length ? Math.max(...cpuSeries) : null;
  const memPeak = memSeries.length ? Math.max(...memSeries) : null;

  return (
    <div
      className={`${kpiSurface('info')} flex flex-col gap-2 p-4 sm:col-span-2 xl:col-span-1`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Usage now</p>
        <div
          role="group"
          aria-label="Range of the trend"
          className="flex rounded-md border p-0.5 text-[11px]"
        >
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              type="button"
              aria-pressed={minutes === r.minutes}
              onClick={() => setMinutes(r.minutes)}
              className={cn(
                'min-w-6 rounded px-1.5 py-1 text-center transition-colors coarse:px-3 coarse:py-2.5',
                minutes === r.minutes
                  ? 'bg-secondary font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {!running ? (
        <p className="text-sm text-muted-foreground">Not running</p>
      ) : usage.isError ? (
        <p className="min-h-[92px] text-sm text-muted-foreground">
          Could not read usage: {usage.error.message}
        </p>
      ) : !d ? (
        <div
          className="grid grid-cols-2 gap-4"
          role="status"
          aria-label="Reading usage"
        >
          <ReadingSkeleton />
          <ReadingSkeleton />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0">
            <p className="text-lg font-semibold tabular-nums">
              {d.cpuPercent.toFixed(d.cpuPercent < 10 ? 1 : 0)}%
            </p>
            <p className="text-xs text-muted-foreground">
              CPU
              {d.cpuLimitPercent
                ? `, of ${d.cpuLimitPercent / 100} core limit`
                : ''}
            </p>
            <Meter fill={cpuFill} />
            <Line series={cpuSeries} max={d.cpuLimitPercent ?? undefined} />
            <p className="h-4 text-[11px] tabular-nums text-muted-foreground">
              {cpuPeak !== null &&
                `peak ${cpuPeak.toFixed(cpuPeak < 10 ? 1 : 0)}%`}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-lg font-semibold tabular-nums">
              {formatBytes(d.memoryBytes)}
            </p>
            <p className="text-xs text-muted-foreground">
              Memory
              {d.memoryLimitBytes
                ? `, of ${formatBytes(d.memoryLimitBytes)} limit`
                : ''}
            </p>
            <Meter fill={memFill} />
            <Line series={memSeries} max={d.memoryLimitBytes ?? undefined} />
            <p className="h-4 text-[11px] tabular-nums text-muted-foreground">
              {memPeak !== null && `peak ${formatBytes(memPeak)}`}
            </p>
          </div>
        </div>
      )}
      {running && (
        <div className="flex h-4 justify-between text-[11px] text-muted-foreground">
          <span>
            {cpuSeries.length > 1
              ? agoLabel(minutes)
              : 'History builds up as it is sampled'}
          </span>
          {d && d.instances > 1 && (
            <span>Added up over {d.instances} instances</span>
          )}
          <span>now</span>
        </div>
      )}
    </div>
  );
}
