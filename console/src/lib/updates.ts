import type { ReleaseStatus } from '@/lib/backend';

/** Where the documentation explains the parts of updating that are not a button */
export const UPDATE_DOCS = {
  upgrading: 'https://docs.provelox.com/guide/install#upgrading',
  oldImage:
    'https://docs.provelox.com/guide/install#if-your-server-runs-the-old-image-name',
} as const;

/** What the notice and the Updates page need to say about a newer release */
export interface UpdateNotice {
  current: string;
  latest: string;
  step: 'major' | 'minor' | 'patch';
  careful: boolean;
  notesUrl: string | null;
  imageMoved: boolean;
  canUpdate: boolean;
  /** The Updates page has this release's notes, so "What changed" can go there instead of to GitHub */
  hasNotes: boolean;
}

/** The notice for a status, or null when there is nothing to tell (or checking is off) */
export function noticeOf(s: ReleaseStatus | null): UpdateNotice | null {
  if (!s?.enabled || !s.updateAvailable || !s.current || !s.latest || !s.step)
    return null;
  return {
    current: s.current,
    latest: s.latest,
    step: s.step,
    careful: s.careful,
    notesUrl: s.notesUrl,
    imageMoved: s.imageMoved,
    canUpdate: s.canUpdate,
    hasNotes: (s.noteCount ?? s.notes?.length ?? 0) > 0,
  };
}

/** Where a person's "not now" is remembered, in this browser only */
export const DISMISS_KEY = 'pvx-update-dismissed';

/** A notice stays hidden for the release it was dismissed for, and comes back for the next one */
export function shouldShow(
  notice: UpdateNotice | null,
  dismissed: string | null,
): notice is UpdateNotice {
  return !!notice && dismissed !== notice.latest;
}

/** The steps' plain names */
export const STEP_NAME = {
  patch: 'a fix release',
  minor: 'a minor release',
  major: 'a major release',
} as const;

/** The lines a person reads before confirming: what happens, and what to do first when it matters */
export function confirmLines(n: UpdateNotice): string[] {
  const lines = [
    `Provelox moves from ${n.current} to ${n.latest}. The console and the API restart, so this page is unavailable for about a minute. Your apps keep running, and your settings and data stay.`,
    'If the new release does not start, Docker puts the old one back by itself.',
  ];
  if (n.careful)
    lines.push(
      `This is ${STEP_NAME[n.step]}, and before 1.0 such a release can change what Provelox stores, in a way an older one cannot read. Copy the data volume first if you might want to go back (the install guide shows how). Updating only goes forward.`,
    );
  return lines;
}

/** What watching an update has seen so far, and what it concludes */
export type Phase = 'updating' | 'done' | 'rolled-back' | 'slow';
export interface Progress {
  phase: Phase;
  /** The API has been seen not answering: the restart began */
  sawDown: boolean;
  /** Times the API answered, after a restart, still on the old release */
  upOld: number;
  ticks: number;
}
export const START: Progress = {
  phase: 'updating',
  sawDown: false,
  upOld: 0,
  ticks: 0,
};
export const POLL_MS = 3000;
/** The API back, still the old release, this many looks in a row (30 s): Docker rolled the update back */
export const ROLLED_BACK_AFTER = 10;
/** Ten minutes of looking without an answer either way */
export const SLOW_AFTER = 200;

/**
 * One look at the server, folded into what is known. `up` is whether the API answered (null: this browser cannot reach
 * the console), `running` the release it says it runs. Finished means running the release that was asked for.
 */
export function advance(
  p: Progress,
  look: { up: boolean | null; running: string | null },
  target: string,
): Progress {
  if (p.phase !== 'updating') return p;
  const ticks = p.ticks + 1;
  if (look.up === true && look.running === target)
    return { ...p, ticks, phase: 'done' };
  const sawDown = p.sawDown || look.up !== true;
  const upOld =
    look.up === true && look.running !== null && p.sawDown ? p.upOld + 1 : 0;
  if (upOld >= ROLLED_BACK_AFTER)
    return { phase: 'rolled-back', sawDown, upOld, ticks };
  if (ticks >= SLOW_AFTER) return { phase: 'slow', sawDown, upOld, ticks };
  return { phase: 'updating', sawDown, upOld, ticks };
}
