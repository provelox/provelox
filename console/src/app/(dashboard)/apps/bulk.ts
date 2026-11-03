import type { AppRow } from './app-row';

export type BulkAction = 'restart' | 'stop' | 'start' | 'move';

export const BULK_LABEL: Record<BulkAction, string> = {
  restart: 'Restart',
  stop: 'Stop',
  start: 'Start',
  move: 'Move to collection',
};

export interface BulkPlan {
  /** The apps the action will be applied to */
  apply: AppRow[];
  /** The apps it does not apply to, with why: shown before anything happens */
  skip: { name: string; reason: string }[];
}

/**
 * What an action does to a selection. An action only touches apps it makes sense for: restarting a stopped app or
 * starting a running one would be an error, and an app of a project cannot be moved out of its stack. Nothing is
 * refused silently: whatever is left out is listed with its reason.
 */
export function planBulk(action: BulkAction, rows: AppRow[]): BulkPlan {
  const apply: AppRow[] = [];
  const skip: BulkPlan['skip'] = [];
  for (const r of rows) {
    const why = reasonToSkip(action, r);
    if (why) skip.push({ name: r.name, reason: why });
    else apply.push(r);
  }
  return { apply, skip };
}

function reasonToSkip(action: BulkAction, r: AppRow): string | null {
  switch (action) {
    case 'restart':
      if (r.instanceCount === 0) return 'It is stopped.';
      // a project's apps have an image from the project even though they show no version
      if (r.version === 0 && !r.project) return 'Nothing is deployed yet.';
      return null;
    case 'stop':
      return r.instanceCount === 0 ? 'It is already stopped.' : null;
    case 'start':
      return r.instanceCount > 0 ? 'It is already running.' : null;
    case 'move':
      return r.project ? `It belongs to the project ${r.project}.` : null;
  }
}

export interface BulkOutcome {
  name: string;
  error?: string;
}

/** One sentence for what happened to a batch. */
export function summarizeBulk(
  action: BulkAction,
  outcomes: BulkOutcome[],
): string {
  const failed = outcomes.filter((o) => o.error);
  const done = outcomes.length - failed.length;
  const word: Record<BulkAction, string> = {
    restart: 'Restarting',
    stop: 'Stopped',
    start: 'Started',
    move: 'Moved',
  };
  const apps = (n: number) => `${n} app${n === 1 ? '' : 's'}`;
  if (failed.length === 0) return `${word[action]} ${apps(done)}`;
  if (done === 0)
    return `Could not ${BULK_LABEL[action].toLowerCase()} ${failed.length === 1 ? failed[0].name : apps(failed.length)}: ${failed[0].error}`;
  return `${word[action]} ${apps(done)}, but ${failed.map((f) => f.name).join(', ')} failed: ${failed[0].error}`;
}
