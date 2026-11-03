import { describe, expect, it } from 'vitest';
import {
  sameRow,
  sortRows,
  type AppRow,
} from '../src/app/(dashboard)/apps/app-row';

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

const names = (rows: AppRow[]) => rows.map((r) => r.name);

describe('sortRows', () => {
  const rows = [
    row('b', { runState: 'running', lastDeployed: '2026-01-02T00:00:00Z' }),
    row('a', { runState: 'failed', lastDeployed: '2026-01-01T00:00:00Z' }),
    row('c', { instanceCount: 0 }),
    row('d', { runState: 'starting', lastDeployed: '2026-01-03T00:00:00Z' }),
    row('e', { runState: 'running', health: 'unhealthy' }),
  ];

  it('sorts by name', () => {
    expect(names(sortRows(rows, 'name'))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('puts problems first, then stopped last', () => {
    expect(names(sortRows(rows, 'status'))).toEqual(['a', 'e', 'd', 'b', 'c']);
  });

  it('puts the heaviest first, and apps with no reading at the end in name order', () => {
    const usage = {
      b: { cpuPercent: 5, memoryBytes: 100 },
      d: { cpuPercent: 50, memoryBytes: 10 },
    };
    expect(names(sortRows(rows, 'cpu', usage))).toEqual([
      'd',
      'b',
      'a',
      'c',
      'e',
    ]);
    expect(names(sortRows(rows, 'memory', usage))).toEqual([
      'b',
      'd',
      'a',
      'c',
      'e',
    ]);
  });

  it('puts the latest deploy first, and never-deployed last', () => {
    expect(names(sortRows(rows, 'deployed'))).toEqual([
      'd',
      'b',
      'a',
      'c',
      'e',
    ]);
  });

  it('does not change the list it was given', () => {
    const before = names(rows);
    sortRows(rows, 'status');
    expect(names(rows)).toEqual(before);
  });
});

describe('sameRow', () => {
  const a = row('a', {
    runState: 'running',
    domains: [
      { host: 'a.example.com', ssl: true, url: 'https://a.example.com' },
    ],
    update: undefined,
  });

  it('is true for a refreshed copy with the same content, and for the very same row', () => {
    expect(sameRow(a, a)).toBe(true);
    expect(sameRow(a, JSON.parse(JSON.stringify(a)))).toBe(true);
  });

  it('notices every kind of change a row shows', () => {
    for (const change of [
      { instanceCount: 0 },
      { runState: 'failed' as const },
      { health: 'unhealthy' as const },
      { version: 2 },
      { image: 'x/y:2' },
      { lastDeployed: '2026-01-01T00:00:00Z' },
      { building: true },
      { project: 'blog' },
      { domains: [] },
      {
        domains: [
          { host: 'a.example.com', ssl: false, url: 'http://a.example.com' },
        ],
      },
    ])
      expect(sameRow(a, { ...a, ...change }), JSON.stringify(change)).toBe(
        false,
      );
  });

  it('notices a field that only the second row has', () => {
    const plain = row('p');
    expect(sameRow(plain, { ...plain, project: 'blog' })).toBe(false);
    expect(sameRow({ ...plain, project: 'blog' }, plain)).toBe(false);
  });
});
