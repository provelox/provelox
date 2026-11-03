import { describe, expect, it } from 'vitest';
import { matches, parse, type Entry } from '@/lib/palette';

const entry = (title: string, keywords: string[] = [], subtitle?: string) =>
  ({
    id: title,
    section: 'pages',
    title,
    subtitle,
    keywords,
    icon: () => null,
  }) as unknown as Entry;

describe('palette parse', () => {
  it('reads no mode for plain text', () => {
    expect(parse('  files ')).toEqual({ mode: null, text: 'files' });
  });
  it('maps prefixes to sections and strips them', () => {
    expect(parse('> new app')).toEqual({ mode: 'actions', text: 'new app' });
    expect(parse('#files')).toEqual({ mode: 'apps', text: 'files' });
    expect(parse('/ sec')).toEqual({ mode: 'pages', text: 'sec' });
  });
});

describe('palette matches', () => {
  it('matches everything on empty text', () => {
    expect(matches(entry('Apps'), '')).toBe(true);
  });
  it('requires every word, across title, subtitle and keywords', () => {
    const e = entry('Security', ['password'], 'Settings');
    expect(matches(e, 'sec pass')).toBe(true);
    expect(matches(e, 'settings password')).toBe(true);
    expect(matches(e, 'sec nope')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(matches(entry('API keys'), 'API KEYS')).toBe(true);
  });
});

describe('palette matches: scope and settings sections', () => {
  it('offers an app’s own sections only when the app is named', () => {
    const e = { ...entry('site · Sign in with…', ['oauth']), scope: 'site' };
    expect(matches(e, 'oauth')).toBe(false);
    expect(matches(e, 'site oauth')).toBe(true);
    expect(matches(e, 'oauth SITE')).toBe(true);
    expect(matches(e, '')).toBe(true);
  });

  it('finds the sign-in section by the words people use for it', async () => {
    const { appNav } = await import('@/lib/nav');
    const sections = appNav().flatMap((p) => p.sections);
    const sso = sections.find((s) => s.id === 'sso');
    for (const word of ['oauth', 'signin', 'google', 'okta', 'sso'])
      expect(sso?.keywords).toContain(word);
    expect(sections.find((s) => s.id === 'cdn')?.keywords).toContain(
      'cloudfront',
    );
  });
});

describe('an app’s sections, in the order people work', () => {
  it('lists Networking from reaching the app to the rarely used', async () => {
    const { appNav } = await import('@/lib/nav');
    const ids = (href: string) =>
      appNav()
        .find((p) => p.href === href)
        ?.sections.map((s) => s.id);
    expect(ids('/networking')).toEqual([
      'web',
      'domains',
      'sso',
      'password',
      'cdn',
      'ports',
      'internal',
      'error-pages',
    ]);
    expect(ids('/configuration')).toEqual([
      'environment',
      'secrets',
      'storage',
      'runtime',
      'placement',
    ]);
  });
});
