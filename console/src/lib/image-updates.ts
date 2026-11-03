export type UpdateKind = 'major' | 'minor' | 'patch' | 'newer';

/** What Provelox says about the registry's copy of one app's image. */
export interface ImageUpdate {
  app: string;
  image: string;
  tag: string | null;
  latest: { tag: string; kind: UpdateKind } | null;
  /** The registry holds another build under the tag the app runs */
  rebuilt: boolean;
  checkedAt: string | null;
  error: string | null;
}

/** One line for a badge, or null when the image is up to date (or could not be checked). */
export function updateLabel(u: ImageUpdate | undefined): string | null {
  if (!u) return null;
  if (u.latest) return u.latest.tag;
  if (u.rebuilt) return 'new build';
  return null;
}

/** What the badge says when pointed at. */
export function updateTitle(u: ImageUpdate): string {
  const parts: string[] = [];
  if (u.latest)
    parts.push(
      `${u.latest.tag} is available${
        u.latest.kind === 'newer' ? '' : ` (a ${u.latest.kind} update)`
      }. This app runs ${u.tag}.`,
    );
  if (u.rebuilt)
    parts.push(
      `The registry holds a different build under ${u.tag} than the one this app is running. Redeploy to pick it up.`,
    );
  return parts.join(' ');
}

/** Amber for a step that may break things, blue for the rest. */
export const updateTone = (u: ImageUpdate) =>
  u.latest?.kind === 'major'
    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
    : 'bg-sky-500/10 text-sky-700 dark:text-sky-300';
