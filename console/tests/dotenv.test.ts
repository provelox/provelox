import { describe, expect, it } from 'vitest';
import { formatEnv, mergeEnv, parseEnv } from '@/lib/dotenv';

describe('parseEnv', () => {
  it('reads plain lines, export, comments and blanks', () => {
    const r = parseEnv('# a comment\n\nA=1\nexport B = two words\nC=\n');
    expect(r.problems).toEqual([]);
    expect(r.rows).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'C', value: '' },
    ]);
  });
  it('handles quotes and trailing comments', () => {
    const r = parseEnv(
      `A="x # not a comment"\nB='it''s'\nC=value # a comment\nD=a#b\nE="tab\\there"`,
    );
    expect(r.rows).toEqual([
      { key: 'A', value: 'x # not a comment' },
      { key: 'B', value: 'it' },
      { key: 'C', value: 'value' },
      { key: 'D', value: 'a#b' },
      { key: 'E', value: 'tab\there' },
    ]);
  });
  it('reads a double-quoted value that runs over several lines, like a private key', () => {
    const r = parseEnv(
      'K="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nNEXT=1',
    );
    expect(r.problems).toEqual([]);
    expect(r.rows[0]).toEqual({
      key: 'K',
      value: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
    });
    expect(r.rows[1]).toEqual({ key: 'NEXT', value: '1' });
  });
  it('lets the last of a repeated name win and reports what it cannot read', () => {
    const r = parseEnv('A=1\nnot a line\nA=2\n1BAD=x\nQ="never closed');
    expect(r.rows).toEqual([{ key: 'A', value: '2' }]);
    expect(r.problems.map((p) => p.message)).toEqual([
      'Expected NAME=value.',
      'Q: the quote is never closed.',
      '1BAD: a name uses letters, digits and underscores and does not start with a digit.',
    ]);
  });
  it('reads a JSON object, and refuses nested values', () => {
    const r = parseEnv('{"A":"1","B":2,"C":true,"D":null,"E":{"x":1}}');
    expect(r.rows).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
      { key: 'C', value: 'true' },
      { key: 'D', value: '' },
    ]);
    expect(r.problems).toHaveLength(1);
    expect(parseEnv('{nope').problems[0].message).toMatch(/not valid JSON/);
  });
  it('refuses a value that is too long, and more than the limit', () => {
    expect(parseEnv(`A=${'x'.repeat(10_001)}`).problems[0].message).toMatch(
      /longer/,
    );
    const many = Array.from({ length: 201 }, (_, i) => `V${i}=1`).join('\n');
    expect(
      parseEnv(many).problems.some((p) => /At most 200/.test(p.message)),
    ).toBe(true);
  });
});

describe('formatEnv', () => {
  it('reads back as the same variables, whatever the values hold', () => {
    const rows = [
      { key: 'PLAIN', value: 'abc-123' },
      { key: 'SPACE', value: 'two words' },
      { key: 'EMPTY', value: '' },
      { key: 'QUOTE', value: 'say "hi" \\ there' },
      { key: 'MULTI', value: 'line1\nline2\ttabbed' },
      { key: 'HASH', value: 'a # b' },
      { key: 'URL', value: 'postgres://u:p@host:5432/db?x=1' },
    ];
    expect(parseEnv(formatEnv(rows)).rows).toEqual(rows);
  });
});

describe('mergeEnv', () => {
  const current = [
    { key: 'A', value: '1' },
    { key: 'B', value: '2' },
  ];
  const incoming = [
    { key: 'B', value: '3' },
    { key: 'C', value: '4' },
    { key: 'A', value: '1' },
  ];
  it('adds and updates, and keeps what is not mentioned', () => {
    const r = mergeEnv(current, incoming, 'merge');
    expect(r.summary).toEqual({
      added: ['C'],
      changed: ['B'],
      unchanged: ['A'],
      removed: [],
    });
    expect(r.rows).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '3' },
      { key: 'C', value: '4' },
    ]);
  });
  it('replaces everything, and says what goes', () => {
    const r = mergeEnv(
      [...current, { key: 'Z', value: '9' }],
      incoming,
      'replace',
    );
    expect(r.summary.removed).toEqual(['Z']);
    expect(r.rows).toEqual(incoming);
  });
});
