import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUPS, SETTINGS_PAGES } from '@/lib/nav';

describe('settings pages', () => {
  it('are grouped, one topic to a page, each under /settings and reachable once', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      'General',
      'Access',
      'Sources',
      'Infrastructure',
    ]);
    const hrefs = SETTINGS_PAGES.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const h of hrefs) expect(h).toMatch(/^\/settings\/[a-z-]+$/);
  });

  it('say what each is for, and can be found by other words', () => {
    for (const p of SETTINGS_PAGES) {
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.keywords.length).toBeGreaterThan(0);
    }
  });
});
