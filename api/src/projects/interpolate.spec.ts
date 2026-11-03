import { interpolate } from './interpolate';

const vars = { A: 'a', EMPTY: '' };

describe('interpolate', () => {
  it('substitutes $VAR and ${VAR}', () => {
    expect(interpolate('x-$A-${A}', vars).value).toBe('x-a-a');
  });
  it('keeps $$ as a literal dollar', () => {
    expect(interpolate('cost $$5', vars).value).toBe('cost $5');
  });
  it('applies defaults: ":-" covers empty, "-" only unset', () => {
    expect(interpolate('${NOPE:-d}', vars).value).toBe('d');
    expect(interpolate('${EMPTY:-d}', vars).value).toBe('d');
    expect(interpolate('${EMPTY-d}', vars).value).toBe('');
    expect(interpolate('${NOPE-d}', vars).value).toBe('d');
  });
  it('applies alternates', () => {
    expect(interpolate('${A:+yes}', vars).value).toBe('yes');
    expect(interpolate('${NOPE:+yes}', vars).value).toBe('');
  });
  it('reports required variables', () => {
    expect(interpolate('${NOPE:?need it}', vars).errors).toEqual(['need it']);
    expect(interpolate('${EMPTY:?}', vars).errors).toEqual([
      'EMPTY is required',
    ]);
    expect(interpolate('${A:?x}', vars).errors).toEqual([]);
  });
  it('reports unset variables and substitutes empty', () => {
    const r = interpolate('p=${NOPE}', vars);
    expect(r.value).toBe('p=');
    expect(r.unset).toEqual(['NOPE']);
  });
  it('leaves text without variables alone', () => {
    expect(interpolate('plain 100%', vars).value).toBe('plain 100%');
  });
});
