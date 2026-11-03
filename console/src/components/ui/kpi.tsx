import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type KpiTone = 'neutral' | 'good' | 'bad' | 'warn' | 'info';

/** A card's tint: a wash of the tone's colour from a corner, so a figure that matters stands out without shouting. */
const SURFACE: Record<KpiTone, string> = {
  neutral: 'bg-gradient-to-br from-primary/[0.06] via-card to-card',
  info: 'bg-gradient-to-br from-sky-500/10 via-card to-card',
  good: 'bg-gradient-to-br from-emerald-500/10 via-card to-card',
  warn: 'bg-gradient-to-br from-amber-500/12 via-card to-card',
  bad: 'bg-gradient-to-br from-red-500/12 via-card to-card',
};

const CHIP: Record<KpiTone, string> = {
  neutral: 'bg-primary/12 text-primary',
  info: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  good: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  bad: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

/** The chip when its tile is the current filter: solid, the tone's own colour. */
const CHIP_ON: Record<KpiTone, string> = {
  neutral: 'bg-primary text-primary-foreground',
  info: 'bg-sky-500 text-white',
  good: 'bg-emerald-500 text-white',
  warn: 'bg-amber-500 text-white',
  bad: 'bg-red-500 text-white',
};

const FIGURE: Record<KpiTone, string> = {
  neutral: '',
  info: '',
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
};

/** A tile that is the current filter: its own colour, stronger, with a ring to match, so it reads as "these". */
const ACTIVE: Record<KpiTone, string> = {
  neutral: 'border-primary/60 ring-1 ring-primary/40 from-primary/15',
  info: 'border-sky-500/60 ring-1 ring-sky-500/40 from-sky-500/20',
  good: 'border-emerald-500/60 ring-1 ring-emerald-500/40 from-emerald-500/20',
  warn: 'border-amber-500/60 ring-1 ring-amber-500/40 from-amber-500/22',
  bad: 'border-red-500/60 ring-1 ring-red-500/40 from-red-500/22',
};

export const kpiSurface = (tone: KpiTone = 'neutral', active = false) =>
  cn('rounded-xl border shadow-xs', SURFACE[tone], active && ACTIVE[tone]);
export const kpiFigure = (tone: KpiTone = 'neutral') => FIGURE[tone];

/** The small tinted square that carries a tile's icon. */
export function KpiIcon({
  icon: Icon,
  tone = 'neutral',
  solid = false,
  className,
}: {
  icon: LucideIcon;
  tone?: KpiTone;
  /** Filled: the tile is selected */
  solid?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        solid ? CHIP_ON[tone] : CHIP[tone],
        className,
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** A thin bar for a share of something (running of all, CPU of a core). */
export function KpiBar({
  value,
  tone = 'neutral',
}: {
  /** 0 to 100 */
  value: number;
  tone?: KpiTone;
}) {
  const fill: Record<KpiTone, string> = {
    neutral: 'bg-primary',
    info: 'bg-sky-500',
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    bad: 'bg-red-500',
  };
  return (
    <span className="block h-1 overflow-hidden rounded-full bg-foreground/10">
      <span
        className={cn(
          'block h-full rounded-full transition-[width]',
          fill[tone],
        )}
        style={{
          width: `${Math.min(100, Math.max(value > 0 ? 3 : 0, value))}%`,
        }}
      />
    </span>
  );
}
