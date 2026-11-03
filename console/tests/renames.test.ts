import { describe, expect, it } from 'vitest';
import { formatYaml } from '@/components/code-editor';
import { keptLines, renamesFrom } from '@/lib/renames';
import type { RenameCandidate } from '@/lib/types';

const cands: RenameCandidate[] = [
  { from: 'web', to: 'site', reason: 'The same image (acme/web).' },
  { from: 'db', to: 'database', reason: 'The same data mounts (/data).' },
];

describe('renamesFrom', () => {
  it('sends every suggestion nobody has answered: carrying on is the recommended choice', () => {
    expect(renamesFrom(cands, {})).toEqual({ site: 'web', database: 'db' });
  });
  it('leaves out the ones that were unchecked, keyed by the new name', () => {
    expect(renamesFrom(cands, { site: false })).toEqual({ database: 'db' });
    expect(renamesFrom(cands, { site: false, database: false })).toEqual({});
  });
  it('is empty when there is no suggestion', () => {
    expect(renamesFrom([], { site: true })).toEqual({});
  });
});

describe('keptLines', () => {
  it('lists the addresses with HTTPS and primary, then the other settings', () => {
    expect(
      keptLines({
        domains: [
          { host: 'portal.one.example', ssl: true },
          { host: 'portal.two.example', ssl: false },
        ],
        primaryDomain: 'portal.one.example',
        features: ['password protection', 'redirect to HTTPS'],
      }),
    ).toEqual([
      'Addresses: portal.one.example (HTTPS, primary), portal.two.example',
      'Also: password protection, redirect to HTTPS',
    ]);
  });
  it('says nothing when there is nothing kept, or nothing known (an older API)', () => {
    expect(
      keptLines({ domains: [], primaryDomain: null, features: [] }),
    ).toEqual([]);
    expect(keptLines(undefined)).toEqual([]);
  });
});

describe('the Format button and the comment about what is kept', () => {
  const file = `services:
  web:
    # Kept from the running app. These are set in Networking and Settings, not in this file:
    # domains: portal.one.example (HTTPS, primary), portal.two.example
    image: acme/web:1
    x-provelox:
      expose: true
      port: 80
`;
  it('keeps the comment lines when the file is formatted', () => {
    const out = formatYaml(file);
    expect(out).not.toBeNull();
    expect(out).toContain('# Kept from the running app.');
    expect(out).toContain(
      '# domains: portal.one.example (HTTPS, primary), portal.two.example',
    );
    expect(out).toContain('image: acme/web:1');
  });
});
