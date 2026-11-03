import type { AppUsage } from './backend';

/**
 * How full a reading is against its limit, 0 to 1, or null when there is no limit to be full against. An app can
 * briefly read above its CPU limit, so it is capped.
 */
export function fillOf(value: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null;
  return Math.min(1, Math.max(0, value / limit));
}

/** The readings shown as a line, as the points of an SVG polyline in a width x height box. */
export function sparkline(
  series: number[],
  width: number,
  height: number,
  max?: number,
) {
  if (series.length < 2) return '';
  const top = max ?? Math.max(...series, 1);
  const step = width / (series.length - 1);
  return series
    .map(
      (v, i) =>
        `${(i * step).toFixed(1)},${(height - (Math.min(v, top) / top) * height).toFixed(1)}`,
    )
    .join(' ');
}

/** The ranges the usage tile can show, in minutes. */
export const RANGES = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
] as const;

/** "1h ago", "15m ago": how far back a range reaches, for the label under the line. */
export function agoLabel(minutes: number): string {
  return minutes >= 60 ? `${minutes / 60}h ago` : `${minutes}m ago`;
}

export type { AppUsage };
