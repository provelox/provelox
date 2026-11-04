import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReleaseNotes } from '@/app/(dashboard)/settings/updates/release-notes';
import type { ReleaseNote } from '@/lib/backend';

const note = (
  version: string,
  body: string,
  over: Partial<ReleaseNote> = {},
): ReleaseNote => ({
  version,
  publishedAt: '2026-11-03T22:00:00.000Z',
  url: `https://github.com/provelox/provelox/releases/tag/v${version}`,
  body,
  ...over,
});
const html = (notes: ReleaseNote[], current: string | null = '0.5.0') =>
  renderToStaticMarkup(createElement(ReleaseNotes, { notes, current }));

describe('ReleaseNotes', () => {
  it('shows nothing when there is nothing to read', () => {
    expect(html([])).toBe('');
  });

  it('renders the notes as structure: headings, lists, emphasis and code', () => {
    const out = html([
      note(
        '0.5.1',
        '### Console\n- **Update** from `Settings`\n- second\n\n1. one\n2. two',
      ),
    ]);
    expect(out).toContain('<h4');
    expect(out).toContain('Console');
    expect(out).toContain('<ul');
    expect(out).toContain('<strong');
    expect(out).toContain('<code');
    expect(out).toContain('<ol');
  });

  it('opens the newest release and leaves the others closed, newest first', () => {
    const out = html([
      note('0.5.3', 'three'),
      note('0.5.2', 'two'),
      note('0.5.1', 'one'),
    ]);
    const opened = (out.match(/<details[^>]*>/g) ?? []).map((d) =>
      / open=""/.test(d),
    );
    expect(opened).toEqual([true, false, false]);
    expect(out.indexOf('v0.5.3')).toBeLessThan(out.indexOf('v0.5.2'));
    expect(out.indexOf('v0.5.2')).toBeLessThan(out.indexOf('v0.5.1'));
    expect(out).toContain('3 releases since v0.5.0');
  });

  it('says so when a release has no notes, and still links to it', () => {
    const out = html([note('0.5.1', '')]);
    expect(out).toContain('No notes were published for this release.');
    expect(out).toContain('Open on GitHub');
  });

  it('never lets the text run a script, load an image or follow a non-https link', () => {
    const out = html([
      note(
        '0.5.1',
        [
          '<script>alert(1)</script>',
          '<img src=x onerror=alert(2)>',
          '<a href="javascript:alert(3)">raw html link</a>',
          '[click](javascript:alert(4))',
          '[data](data:text/html;base64,AAAA)',
          '[relative](/settings)',
          '![tracker](https://evil.example/pixel.png)',
          '[docs](https://docs.provelox.com/guide/install)',
        ].join('\n\n'),
      ),
    ]);
    expect(out).not.toMatch(
      /<script|<img|onerror|javascript:|data:text|evil\.example|href="\/settings"/i,
    );
    // the good link survives, in a new tab, without giving the page to the other site
    expect(out).toMatch(
      /<a href="https:\/\/docs\.provelox\.com\/guide\/install" target="_blank" rel="noopener noreferrer"/,
    );
    // the words of the bad links are still readable, as plain text
    expect(out).toContain('click');
    expect(out).toContain('relative');
  });
});
