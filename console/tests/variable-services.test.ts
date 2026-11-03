import { describe, expect, it } from 'vitest';
import { variableServices } from '../src/lib/compose-vars';

describe('variableServices', () => {
  it('lists the services that use each variable, in file order', () => {
    const compose = `
services:
  a:
    image: x
    environment:
      USER: \${DB_USER}
      PASS: \${DB_PASS}
  b:
    image: y
    environment:
      USER: \${DB_USER}
`;
    expect(variableServices(compose)).toEqual({
      DB_USER: ['a', 'b'],
      DB_PASS: ['a'],
    });
  });

  it('gives nothing back for a file that cannot be read', () => {
    expect(variableServices('services: [')).toEqual({});
    expect(variableServices('')).toEqual({});
  });
});
