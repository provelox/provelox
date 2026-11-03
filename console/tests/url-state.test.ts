import { describe, expect, it } from 'vitest';
import { withParam } from '@/lib/url-state';

describe('withParam', () => {
  it('sets a parameter and keeps the rest of the address', () => {
    expect(withParam('http://x.test/apps?sort=name#top', 'q', 'crm db')).toBe(
      '/apps?sort=name&q=crm+db#top',
    );
  });
  it('replaces one that is there', () => {
    expect(withParam('http://x.test/apps?q=old', 'q', 'new')).toBe(
      '/apps?q=new',
    );
  });
  it('removes it when it is empty or the default, so the address stays clean', () => {
    expect(withParam('http://x.test/apps?q=old', 'q', '')).toBe('/apps');
    expect(
      withParam('http://x.test/apps?status=all', 'status', 'all', 'all'),
    ).toBe('/apps');
  });
  it('handles characters that need escaping', () => {
    const out = withParam('http://x.test/apps', 'q', 'a&b=c#d');
    expect(new URL(out, 'http://x.test').searchParams.get('q')).toBe('a&b=c#d');
  });
});
