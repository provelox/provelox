/**
 * The apps a person pins, and the ones they opened last, kept in this browser. They only decide what the sidebar offers,
 * so losing them (cleared site data, another browser) costs nothing.
 */
export const PINNED_KEY = 'provelox:pinned';
export const RECENT_KEY = 'provelox:recent';
export const MAX_PINNED = 12;
export const MAX_RECENT = 6;

const names = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((x): x is string => typeof x === 'string'))]
    : [];

export function parseNames(text: string | null): string[] {
  try {
    return names(JSON.parse(text ?? '[]'));
  } catch {
    return [];
  }
}

/** Pins an app (at the end), or unpins it when it already is. */
export function togglePin(pinned: string[], app: string): string[] {
  return pinned.includes(app)
    ? pinned.filter((n) => n !== app)
    : [...pinned, app].slice(-MAX_PINNED);
}

/** The app as the most recent, once. */
export function visit(recent: string[], app: string): string[] {
  return [app, ...recent.filter((n) => n !== app)].slice(0, MAX_RECENT);
}

/** Drops apps that no longer exist, so the sidebar never links to one that is gone. */
export const existing = (list: string[], apps: Set<string>) =>
  list.filter((n) => apps.has(n));

/** The app under a new name, wherever it is listed. */
export const renamed = (list: string[], from: string, to: string) =>
  list.map((n) => (n === from ? to : n));
