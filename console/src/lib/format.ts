export function formatBytes(n?: number | null) {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * The size of a machine's memory as it was sold. The operating system reports a little less than is installed (the
 * kernel keeps some), so 48 GB shows as 47: take the next usual size up when the reading is within 8% below it.
 */
export function formatMachineRam(bytes?: number | null) {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb < 1) return formatBytes(bytes);
  const usual = [
    1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768,
    1024,
  ];
  const near = usual.find((u) => u >= gb && u * 0.92 <= gb);
  return `${near ?? Math.round(gb)} GB`;
}

/** Accepts an ISO string or seconds since the epoch. */
export function formatDate(value?: string | number) {
  if (value === undefined || value === '' || value === 0) return '';
  const d =
    typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. Empty for a missing or invalid time. */
export function timeAgo(value?: string, now = Date.now()) {
  if (!value) return '';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(t).toLocaleDateString();
}
