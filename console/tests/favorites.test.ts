import { describe, expect, it } from 'vitest';
import {
  existing,
  MAX_PINNED,
  MAX_RECENT,
  parseNames,
  renamed,
  togglePin,
  visit,
} from '@/lib/favorites';
import { appNav } from '@/lib/nav';

describe('favorites', () => {
  it('reads what was stored, and shrugs off what is not a list of names', () => {
    expect(parseNames('["a","b","a"]')).toEqual(['a', 'b']);
    expect(parseNames('{"a":1}')).toEqual([]);
    expect(parseNames('not json')).toEqual([]);
    expect(parseNames(null)).toEqual([]);
    expect(parseNames('["a",3,null]')).toEqual(['a']);
  });

  it('pins and unpins', () => {
    expect(togglePin([], 'a')).toEqual(['a']);
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b']);
    const many = Array.from({ length: MAX_PINNED }, (_, i) => `app${i}`);
    expect(togglePin(many, 'new')).toHaveLength(MAX_PINNED);
    expect(togglePin(many, 'new').at(-1)).toBe('new');
  });

  it('puts the latest visit first, once, and keeps a few', () => {
    expect(visit(['a', 'b'], 'b')).toEqual(['b', 'a']);
    const long = Array.from({ length: 10 }, (_, i) => `app${i}`);
    expect(visit(long, 'x')).toHaveLength(MAX_RECENT);
  });

  it('drops apps that are gone and follows a rename', () => {
    expect(existing(['a', 'gone'], new Set(['a']))).toEqual(['a']);
    expect(renamed(['a', 'b'], 'a', 'c')).toEqual(['c', 'b']);
  });
});

describe('appNav', () => {
  it('lists the pages in order, with the sections of each and their counts', () => {
    const nav = appNav({ env: 3, domains: 2 });
    expect(nav.map((n) => n.label)).toEqual([
      'Overview',
      'Deployments',
      'Configuration',
      'Networking',
      'Logs',
    ]);
    const cfg = nav.find((n) => n.href === '/configuration')!;
    expect(cfg.sections.find((s) => s.id === 'environment')?.count).toBe(3);
    expect(
      nav
        .find((n) => n.href === '/networking')!
        .sections.find((s) => s.id === 'domains')?.count,
    ).toBe(2);
  });
});
