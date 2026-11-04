import { describe, expect, it } from 'vitest';
import type { ReleaseStatus } from '@/lib/backend';
import {
  advance,
  confirmLines,
  noticeOf,
  POLL_MS,
  ROLLED_BACK_AFTER,
  SLOW_AFTER,
  START,
  shouldShow,
  type Progress,
} from '@/lib/updates';

const status = (over: Partial<ReleaseStatus> = {}): ReleaseStatus => ({
  enabled: true,
  lockedOff: false,
  current: '0.5.0',
  latest: '0.5.1',
  updateAvailable: true,
  step: 'patch',
  careful: false,
  notesUrl: 'https://github.com/provelox/provelox/releases/tag/v0.5.1',
  publishedAt: null,
  checkedAt: null,
  checking: false,
  error: null,
  imageMoved: false,
  canUpdate: true,
  ...over,
});

describe('noticeOf', () => {
  it('tells about a newer release', () => {
    expect(noticeOf(status())).toMatchObject({
      current: '0.5.0',
      latest: '0.5.1',
      step: 'patch',
      canUpdate: true,
    });
  });

  it('says nothing when there is nothing to say', () => {
    expect(noticeOf(null)).toBeNull();
    expect(noticeOf(status({ updateAvailable: false }))).toBeNull();
    expect(noticeOf(status({ enabled: false }))).toBeNull();
    expect(noticeOf(status({ current: null }))).toBeNull();
    expect(noticeOf(status({ latest: null }))).toBeNull();
    expect(noticeOf(status({ step: null }))).toBeNull();
  });

  it('carries what the page needs to explain why it cannot update', () => {
    expect(
      noticeOf(status({ imageMoved: true, canUpdate: true })),
    ).toMatchObject({ imageMoved: true });
    expect(noticeOf(status({ canUpdate: false }))).toMatchObject({
      canUpdate: false,
    });
  });
});

describe('shouldShow', () => {
  it('shows until it is dismissed for that release, and again for the next', () => {
    const n = noticeOf(status())!;
    expect(shouldShow(n, null)).toBe(true);
    expect(shouldShow(n, '0.5.1')).toBe(false);
    expect(shouldShow(n, '0.5.0')).toBe(true);
    const next = noticeOf(status({ latest: '0.5.2' }))!;
    expect(shouldShow(next, '0.5.1')).toBe(true);
    expect(shouldShow(null, null)).toBe(false);
  });
});

describe('confirmLines', () => {
  it('says what happens, and that the old release comes back if the new one fails', () => {
    const lines = confirmLines(noticeOf(status())!).join(' ');
    expect(lines).toMatch(/0\.5\.0 to 0\.5\.1/);
    expect(lines).toMatch(/apps keep running/);
    expect(lines).toMatch(/puts the old one back/);
    expect(lines).not.toMatch(/data volume/);
  });

  it('warns about the data before a step that can change it', () => {
    const lines = confirmLines(
      noticeOf(status({ latest: '0.6.0', step: 'minor', careful: true }))!,
    ).join(' ');
    expect(lines).toMatch(/minor release/);
    expect(lines).toMatch(/Copy the data volume first/);
    expect(lines).toMatch(/only goes forward/);
  });
});

describe('advance (watching an update)', () => {
  const run = (looks: { up: boolean | null; running: string | null }[]) =>
    looks.reduce<Progress>((p, l) => advance(p, l, '0.5.1'), START);
  const old = { up: true, running: '0.5.0' };
  const down = { up: false, running: null };
  const unreachable = { up: null, running: null };
  const fresh = { up: true, running: '0.5.1' };

  it('is finished as soon as the API answers on the release that was asked for', () => {
    expect(run([old, down, fresh]).phase).toBe('done');
    // even when the restart was too quick to be seen
    expect(run([fresh]).phase).toBe('done');
  });

  it('keeps waiting while it is still the old release, before any restart is seen', () => {
    const p = run(Array(20).fill(old));
    expect(p.phase).toBe('updating');
    expect(p.sawDown).toBe(false);
  });

  it('remembers that the API went away', () => {
    expect(run([old, down]).sawDown).toBe(true);
    expect(run([unreachable]).sawDown).toBe(true);
  });

  it('concludes that Docker rolled the update back when the old release returns and stays', () => {
    const looks = [old, down, ...Array(ROLLED_BACK_AFTER).fill(old)];
    expect(run(looks).phase).toBe('rolled-back');
    // one look short of it is still waiting
    expect(run(looks.slice(0, -1)).phase).toBe('updating');
  });

  it('does not count the old release as a rollback until a restart was seen', () => {
    expect(run(Array(ROLLED_BACK_AFTER + 5).fill(old)).phase).toBe('updating');
  });

  it('starts the count again when the API goes away once more', () => {
    const looks = [
      old,
      down,
      ...Array(ROLLED_BACK_AFTER - 1).fill(old),
      down,
      old,
    ];
    expect(run(looks).phase).toBe('updating');
  });

  it('says it is slow after ten minutes without an answer either way', () => {
    expect(SLOW_AFTER * POLL_MS).toBe(10 * 60_000);
    expect(run(Array(SLOW_AFTER).fill(down)).phase).toBe('slow');
    expect(run(Array(SLOW_AFTER - 1).fill(down)).phase).toBe('updating');
  });

  it('does not change once it has concluded', () => {
    const done = run([fresh]);
    expect(advance(done, down, '0.5.1')).toBe(done);
  });
});
