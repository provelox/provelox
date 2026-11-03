import { describe, expect, it } from 'vitest';
import { buildAuthPatch, generatePassword, parsePaths } from '@/lib/basic-auth';

describe('parsePaths', () => {
  it('reads lines or commas, without blanks or repeats', () => {
    expect(parsePaths('/a\n\n /b , /a,/c')).toEqual(['/a', '/b', '/c']);
  });
});

describe('buildAuthPatch', () => {
  const ok = (
    rows: Parameters<typeof buildAuthPatch>[0],
    paths: string[] = [],
  ) => buildAuthPatch(rows, paths);

  it('sends a new password, and keeps a saved one that was left empty', () => {
    const r = ok([
      { name: 'a', password: '', saved: true },
      { name: 'b', password: 'password two', saved: false },
      { name: 'c', password: 'changed pass', saved: true },
    ]);
    expect(r).toEqual({
      ok: true,
      patch: {
        users: [
          { name: 'a', keep: true },
          { name: 'b', password: 'password two' },
          { name: 'c', password: 'changed pass' },
        ],
        openPaths: [],
      },
    });
  });

  it('says what is wrong, in words', () => {
    expect(ok([])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/at least one user/),
    });
    expect(
      ok([{ name: 'a b', password: 'password one', saved: false }]),
    ).toMatchObject({ ok: false });
    expect(ok([{ name: 'a', password: 'short', saved: false }])).toMatchObject({
      error: expect.stringMatching(/at least 8/),
    });
    expect(
      ok([
        { name: 'a', password: 'password one', saved: false },
        { name: 'a', password: 'password two', saved: false },
      ]),
    ).toMatchObject({ error: expect.stringMatching(/listed twice/) });
    expect(
      ok([{ name: 'a', password: 'password one', saved: false }], ['no-slash']),
    ).toMatchObject({
      error: expect.stringMatching(/not a path/),
    });
    expect(
      ok(
        [{ name: 'a', password: 'password one', saved: false }],
        ['/a`) || Host(`x'],
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('generatePassword', () => {
  it('makes passwords that are long enough, typeable, and different each time', () => {
    const a = generatePassword();
    expect(a).toHaveLength(20);
    expect(a).toMatch(/^[A-Za-z2-9]+$/);
    expect(generatePassword()).not.toBe(a);
  });
});
