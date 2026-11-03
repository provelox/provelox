import { lastDeathReason, stateFromTasks, type TaskLike } from './task-state';

const task = (n: number, state: string, err?: string): TaskLike => ({
  CreatedAt: `2026-10-15T00:00:${String(n).padStart(2, '0')}Z`,
  Status: { State: state, Err: err },
});

describe('stateFromTasks', () => {
  it('is stopped with nothing wanted, and running when every wanted instance runs', () => {
    expect(stateFromTasks(0, 0, [])).toEqual({ state: 'stopped' });
    expect(stateFromTasks(2, 2, [])).toEqual({ state: 'running' });
    expect(stateFromTasks(1, 3, [])).toEqual({ state: 'running' });
  });

  it('is starting while instances come up and nothing has gone wrong', () => {
    expect(stateFromTasks(1, 0, [task(1, 'starting')])).toEqual({
      state: 'starting',
    });
    expect(stateFromTasks(1, 0, [])).toEqual({ state: 'starting' });
  });

  it('calls a crash loop failing even though the newest task has not failed yet', () => {
    const loop = [
      task(5, 'starting'), // the restart that is under way
      task(4, 'failed', 'task: non-zero exit (1)'),
      task(3, 'failed', 'task: non-zero exit (1)'),
      task(2, 'failed', 'task: non-zero exit (1)'),
    ];
    expect(stateFromTasks(1, 0, loop)).toEqual({
      state: 'failed',
      message: 'task: non-zero exit (1)',
    });
  });

  it('does not call two failures a loop', () => {
    expect(
      stateFromTasks(1, 0, [
        task(3, 'starting'),
        task(2, 'failed'),
        task(1, 'failed'),
      ]).state,
    ).toBe('starting');
  });

  it('does not count old tasks that were shut down on purpose, or deaths too far back', () => {
    const afterDeploy = [
      task(9, 'starting'),
      task(8, 'shutdown'),
      task(7, 'shutdown'),
      task(6, 'shutdown'),
      task(5, 'shutdown'),
      task(4, 'failed'),
      task(3, 'failed'),
      task(2, 'failed'),
    ];
    expect(stateFromTasks(1, 0, afterDeploy).state).toBe('starting');
  });

  it('is running again as soon as the instance runs, whatever happened before', () => {
    expect(
      stateFromTasks(1, 1, [
        task(3, 'running'),
        task(2, 'failed'),
        task(1, 'failed'),
      ]).state,
    ).toBe('running');
  });
});

describe('lastDeathReason', () => {
  it('gives the reason of the newest task that died, so a rollback can say why', () => {
    const arm =
      'no matching manifest for linux/arm64/v8 in the manifest list entries';
    expect(
      lastDeathReason([
        task(3, 'running'), // the old version Docker went back to
        task(2, 'rejected', arm),
        task(1, 'failed', 'older'),
      ]),
    ).toBe(arm);
  });
  it('is nothing when no task died', () => {
    expect(lastDeathReason([task(1, 'running')])).toBeUndefined();
  });
});
