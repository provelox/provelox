import { createHash } from 'node:crypto';

/** JSON with the keys of every object in order, so the same content always reads the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * A short fingerprint of a setting, so the hub can tell whether a node already has what the fleet should (the hub makes
 * the same one from its own copy; keep the two in step). Null for nothing set.
 */
export function fleetHash(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && Object.keys(value as object).length === 0)
    return null;
  return createHash('sha256')
    .update(canonical(value))
    .digest('hex')
    .slice(0, 16);
}
