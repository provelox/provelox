import { describe, expect, it } from 'vitest';
import {
  declaredVariables,
  extractVariables,
  generateSecret,
} from '@/lib/compose-vars';

describe('extractVariables', () => {
  it('finds plain and braced references once each, in order', () => {
    const v = extractVariables('a: ${B}\nb: $C\nc: ${B}-again\nd: ${A_1}');
    expect(v.map((x) => x.key)).toEqual(['B', 'C', 'A_1']);
  });
  it('reads defaults for ":-" and "-"', () => {
    const v = Object.fromEntries(
      extractVariables('${A:-one} ${B-two} ${C:-}').map((x) => [
        x.key,
        x.default,
      ]),
    );
    expect(v).toEqual({ A: 'one', B: 'two', C: '' });
  });
  it('flags required variables', () => {
    const v = extractVariables('${A:?need A} ${B?} ${C}');
    expect(v.map((x) => [x.key, x.required])).toEqual([
      ['A', true],
      ['B', true],
      ['C', false],
    ]);
  });
  it('merges several references: any default sticks, any "required" wins', () => {
    const [x] = extractVariables('${A} ${A:-d} ${A:?m}');
    expect(x).toEqual({ key: 'A', default: 'd', required: true });
  });
  it('ignores literal dollars and non-variables', () => {
    expect(extractVariables('cost $$5 and $$HOME and ${}')).toEqual([]);
    expect(extractVariables('plain text')).toEqual([]);
  });
  it('does not mistake shell-style text in a value for a second variable', () => {
    expect(
      extractVariables('command: echo ${GREETING:-hi there}').map((x) => x.key),
    ).toEqual(['GREETING']);
  });
});

describe('generateSecret', () => {
  it('has the requested length and only unambiguous characters', () => {
    for (const n of [8, 24, 64]) {
      const s = generateSecret(n);
      expect(s).toHaveLength(n);
      expect(s).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    }
  });
  it('is different every time', () => {
    expect(
      new Set(Array.from({ length: 50 }, () => generateSecret())).size,
    ).toBe(50);
  });
});

describe('extractVariables: minimum length from the message', () => {
  it('reads "at least N characters" and "openssl rand -hex N"', () => {
    const found = extractVariables(
      'A: ${A:?A must be at least 40 characters}\nB: ${B:?B is required (openssl rand -hex 32)}\nC: ${C:?C is required}',
    );
    expect(found.map((v) => v.minLength)).toEqual([40, 32, undefined]);
  });
});

describe('declaredVariables', () => {
  it('reads x-provelox.variables, with kind: secret as a synonym for secret: true', () => {
    const d = declaredVariables(
      'x-provelox:\n  variables:\n    A: { secret: true, minLength: 48, label: Key }\n    B: { kind: secret }\n    C: { description: hi }\nservices:\n  w: { image: x }\n',
    );
    expect(d.A).toMatchObject({ secret: true, minLength: 48, label: 'Key' });
    expect(d.B.secret).toBe(true);
    expect(d.C).toMatchObject({ secret: false, description: 'hi' });
  });
  it('gives nothing for a file that is not valid yet, or declares nothing', () => {
    expect(declaredVariables('services:\n  w: {')).toEqual({});
    expect(declaredVariables('services:\n  w: { image: x }')).toEqual({});
    expect(declaredVariables('')).toEqual({});
  });
});

describe('declaredVariables: a declaration written without a space after the colon', () => {
  const file = (decl: string) =>
    `x-provelox:\n  variables:\n    PW: ${decl}\nservices:\n  db:\n    image: mysql\n    environment:\n      P: \${PW}\n`;

  it('is read as written: secret, label and length (the case YAML reads as one key named "secret:true")', () => {
    expect(
      declaredVariables(file("{secret:true,label: 'Database Root Password'}"))
        .PW,
    ).toMatchObject({ secret: true, label: 'Database Root Password' });
    expect(
      declaredVariables(file('{label: Root, secret:true}')).PW,
    ).toMatchObject({
      secret: true,
      label: 'Root',
    });
    expect(
      declaredVariables(file('{secret:true,minLength:16}')).PW,
    ).toMatchObject({
      secret: true,
      minLength: 16,
    });
    expect(
      declaredVariables(file("{secret:false,description:'shown'}")).PW,
    ).toMatchObject({
      secret: false,
      description: 'shown',
    });
  });

  it('reads the usual spelling the same way', () => {
    expect(
      declaredVariables(file('{ secret: true, minLength: 16 }')).PW,
    ).toMatchObject({
      secret: true,
      minLength: 16,
    });
  });
});
