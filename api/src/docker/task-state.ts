/** Docker's task states that mean "will not become healthy on its own". */
const DEAD = new Set(['failed', 'rejected', 'orphaned']);

export interface TaskLike {
  CreatedAt?: string;
  Status?: { State?: string; Err?: string; Message?: string };
}

export type ServiceState = 'running' | 'starting' | 'failed' | 'stopped';

/** How many of the most recent tasks are looked at, and how many of them must have died to call it a crash loop. */
const WINDOW = 5;
const LOOP_AT = 3;

/**
 * Why the newest task that died did so, in Docker's words ("no matching manifest for linux/arm64/v8", "exec format
 * error", ...). After a rollback the service looks healthy again, so this is the only place the reason survives.
 */
export function lastDeathReason(tasks: TaskLike[]): string | undefined {
  const newest = [...tasks]
    .sort((a, b) => (b.CreatedAt ?? '').localeCompare(a.CreatedAt ?? ''))
    .find((t) => DEAD.has(t.Status?.State ?? ''));
  return newest?.Status?.Err ?? newest?.Status?.Message;
}

/**
 * What a service is doing, from its wanted and running instance counts and its recent tasks.
 *
 * A crash loop is judged over the last few tasks, not the last three: a restarting service always has a newest task
 * that has not failed yet, so looking at only the newest would call a loop "starting" most of the time. Tasks from an
 * old version that were shut down on purpose are not deaths, and do not count.
 */
export function stateFromTasks(
  desired: number,
  running: number,
  tasks: TaskLike[],
): { state: ServiceState; message?: string } {
  if (desired === 0) return { state: 'stopped' };
  if (running >= desired) return { state: 'running' };
  const recent = [...tasks]
    .sort((a, b) => (b.CreatedAt ?? '').localeCompare(a.CreatedAt ?? ''))
    .slice(0, WINDOW);
  const dead = recent.filter((t) => DEAD.has(t.Status?.State ?? ''));
  if (dead.length >= LOOP_AT)
    return {
      state: 'failed',
      message: dead[0].Status?.Err ?? dead[0].Status?.Message,
    };
  return { state: 'starting' };
}
