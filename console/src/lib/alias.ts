/** What an extra internal name may be: a DNS label, as the API accepts it. */
export const ALIAS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a name cannot be added, or null. `existing` are the names already there, `appName` the app's own. */
export function aliasProblem(
  value: string,
  existing: string[],
  appName: string,
): string | null {
  const v = value.trim();
  if (!v) return 'Type a name.';
  if (!ALIAS_RE.test(v))
    return 'Use lowercase letters, numbers and dashes, starting and ending with a letter or number.';
  if (v === appName) return `${v} is already the app's own name.`;
  if (existing.includes(v)) return `${v} is already there.`;
  if (existing.length >= 10) return 'At most 10 extra names.';
  return null;
}
