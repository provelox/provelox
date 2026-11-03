/** A CDN Provelox can put in front of an app, as `GET /v1/cdn` lists it. */
export interface CdnProvider {
  id: string;
  label: string;
  builtin: boolean;
  /** The header the CDN puts the visitor's address in, for the app to read */
  clientIpHeader: string | null;
  /** Where the ranges are fetched from. Null: a fixed list */
  source: string | null;
  ranges: number;
  fetchedAt: string | null;
  /** Why the last refresh kept the saved ranges */
  error: string | null;
  /** Apps that sit behind it */
  apps: string[];
}

const V4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
const V6 = /^[0-9a-fA-F:.]*:[0-9a-fA-F:.]*(\/\d{1,3})?$/;

/** Ranges typed one per line or separated by commas, `#` comments allowed. The server checks them again. */
export function parseRanges(
  text: string,
): { ok: true; ranges: string[] } | { ok: false; error: string } {
  const items = text
    .split('\n')
    .map((l) => l.replace(/#.*/, ''))
    .flatMap((l) => l.split(/[\s,]+/))
    .filter(Boolean);
  if (items.length === 0)
    return { ok: false, error: 'Add at least one address range.' };
  const bad = items.find((i) => !V4.test(i) && !V6.test(i));
  if (bad)
    return {
      ok: false,
      error: `"${bad.slice(0, 40)}" is not an address range, like 203.0.113.0/24.`,
    };
  return { ok: true, ranges: [...new Set(items)] };
}

/** An id for a CDN named by a person: lowercase letters, numbers and dashes. */
export function cdnId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** One line on what is known about a CDN's ranges. */
export function rangesSummary(p: CdnProvider, now = Date.now()): string {
  if (p.ranges === 0)
    return p.source
      ? 'The address ranges are fetched when you save'
      : 'No address ranges';
  const n = `${p.ranges} address ${p.ranges === 1 ? 'range' : 'ranges'}`;
  if (!p.source) return `${n}, listed by hand`;
  if (!p.fetchedAt) return n;
  const mins = Math.max(0, Math.round((now - Date.parse(p.fetchedAt)) / 60000));
  const ago =
    mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins} min ago`
        : mins < 1440
          ? `${Math.floor(mins / 60)} h ago`
          : `${Math.floor(mins / 1440)} d ago`;
  return `${n}, refreshed ${ago}`;
}
