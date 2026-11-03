import { describe, expect, it } from 'vitest';
import { isTheme, resolveTheme, themeScript } from '@/lib/theme';

describe('theme', () => {
  it('knows the three choices', () => {
    for (const t of ['system', 'light', 'dark']) expect(isTheme(t)).toBe(true);
    expect(isTheme('blue')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('follows the device only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('ships a script that reads the saved choice and falls back to the device', () => {
    expect(themeScript).toContain('provelox:theme');
    expect(themeScript).toContain('prefers-color-scheme: dark');
    expect(themeScript).toContain("classList.toggle('dark'");
  });
});
