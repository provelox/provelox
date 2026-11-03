import {
  BRAND_PAGES,
  brandPage,
  placeholderPage,
  type BrandPageCode,
} from './brand-pages';

describe('brandPage', () => {
  const codes = Object.keys(BRAND_PAGES) as BrandPageCode[];

  it.each(codes)(
    '%s is a complete page that needs nothing else to load',
    (code) => {
      const html = brandPage(code);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain(`<title>${code} `);
      expect(html).toContain('<svg');
      expect(html).not.toMatch(/<link|<script|src=|@import|url\(http/i);
    },
  );

  it("uses the brand colors and follows the visitor's light/dark setting", () => {
    const html = brandPage('503');
    expect(html).toContain('#14c9f1');
    expect(html).toContain('#2774fb');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('says what happened and what to do, without naming the app or the server', () => {
    const html = brandPage('503');
    expect(html).toContain('not running right now');
    expect(html).toContain('Try again');
    expect(html).not.toMatch(/traefik|docker|swarm|nginx/i);
  });

  it('is kept out of search results', () => {
    expect(brandPage('404')).toContain('name="robots" content="noindex"');
  });

  it('only covers statuses the proxy can serve', () => {
    expect(codes).toEqual(['404', '502', '503', '504']);
  });

  it('has a first-deploy page in the same style', () => {
    const html = placeholderPage();
    expect(html).toContain('ready for its first deploy');
    expect(html).toContain('#2774fb');
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/<link|<script|src=|@import/i);
  });
});
