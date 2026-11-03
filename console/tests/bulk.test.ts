import { describe, expect, it } from 'vitest';
import type { AppRow } from '../src/app/(dashboard)/apps/app-row';
import { planBulk, summarizeBulk } from '../src/app/(dashboard)/apps/bulk';

const row = (name: string, over: Partial<AppRow> = {}): AppRow => ({
  name,
  domains: [],
  exposed: true,
  customDomainsOnly: false,
  persistent: false,
  instanceCount: 1,
  building: false,
  version: 1,
  ...over,
});

const rows = [
  row('web'),
  row('idle', { instanceCount: 0 }),
  row('fresh', { version: 0 }),
  row('db', { project: 'shop', version: 0 }),
];

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe('planBulk', () => {
  it('restarts what runs and has something deployed, and says why it left the rest out', () => {
    const p = planBulk('restart', rows);
    expect(names(p.apply)).toEqual(['web', 'db']);
    expect(p.skip).toEqual([
      { name: 'idle', reason: 'It is stopped.' },
      { name: 'fresh', reason: 'Nothing is deployed yet.' },
    ]);
  });

  it('stops what runs and starts what is stopped', () => {
    expect(names(planBulk('stop', rows).apply)).toEqual(['web', 'fresh', 'db']);
    expect(planBulk('stop', rows).skip).toEqual([
      { name: 'idle', reason: 'It is already stopped.' },
    ]);
    expect(names(planBulk('start', rows).apply)).toEqual(['idle']);
    expect(planBulk('start', rows).skip).toHaveLength(3);
  });

  it('moves loose apps only: an app of a project stays in its stack', () => {
    const p = planBulk('move', rows);
    expect(names(p.apply)).toEqual(['web', 'idle', 'fresh']);
    expect(p.skip).toEqual([
      { name: 'db', reason: 'It belongs to the project shop.' },
    ]);
  });

  it('plans nothing for an empty selection', () => {
    expect(planBulk('restart', [])).toEqual({ apply: [], skip: [] });
  });
});

describe('summarizeBulk', () => {
  it('says what happened in one sentence', () => {
    expect(summarizeBulk('restart', [{ name: 'a' }, { name: 'b' }])).toBe(
      'Restarting 2 apps',
    );
    expect(summarizeBulk('stop', [{ name: 'a' }])).toBe('Stopped 1 app');
    expect(summarizeBulk('start', [{ name: 'a', error: 'boom' }])).toBe(
      'Could not start a: boom',
    );
    expect(
      summarizeBulk('move', [
        { name: 'a' },
        { name: 'b', error: 'no such group' },
      ]),
    ).toBe('Moved 1 app, but b failed: no such group');
  });
});
