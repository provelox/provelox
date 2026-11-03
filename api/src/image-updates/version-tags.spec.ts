import { isFloating, newestTag, shapeOf } from './version-tags';

describe('newestTag', () => {
  const tags = [
    '1.3.9',
    '1.4.0',
    '1.4.1',
    '1.5.0',
    '2.0.0',
    '1.4.1-alpine',
    '1.6.0-rc1',
    'latest',
    'alpine',
  ];
  it('finds the highest tag of the same shape and says how big the step is', () => {
    expect(newestTag('1.4.0', tags)).toEqual({ tag: '2.0.0', kind: 'major' });
    expect(newestTag('1.4.1', ['1.4.1', '1.4.2'])).toEqual({
      tag: '1.4.2',
      kind: 'patch',
    });
    expect(newestTag('1.4.1', ['1.5.0', '1.4.2'])).toEqual({
      tag: '1.5.0',
      kind: 'minor',
    });
  });
  it('compares numbers, not text', () => {
    expect(newestTag('1.9.0', ['1.10.0', '1.9.1'])?.tag).toBe('1.10.0');
  });
  it('keeps a variant to its own kind', () => {
    expect(
      newestTag('1.4.1-alpine', ['1.4.2-alpine', '2.0.0', '1.4.3']),
    ).toEqual({
      tag: '1.4.2-alpine',
      kind: 'patch',
    });
  });
  it('does not offer a release candidate for a release, or the reverse', () => {
    expect(newestTag('1.4.0', ['1.6.0-rc1'])).toBeNull();
    expect(newestTag('1.6.0-rc1', ['1.6.0-rc2', '1.7.0'])?.tag).toBe(
      '1.6.0-rc2',
    );
  });
  it('handles date tags as simply newer', () => {
    expect(
      newestTag('20261013-050913', [
        '20261013-050913',
        '20261014-010000',
        '20261013-060000',
      ]),
    ).toEqual({
      tag: '20261014-010000',
      kind: 'newer',
    });
  });
  it('leaves a bare major line alone, but compares a date or build number', () => {
    expect(newestTag('8', ['8', '9', '26'])).toBeNull();
    expect(newestTag('16', ['17'])).toBeNull();
    expect(newestTag('20261013', ['20261014'])).toEqual({
      tag: '20261014',
      kind: 'newer',
    });
  });
  it('has nothing to say about a floating tag, or when it is already the newest', () => {
    expect(newestTag('latest', ['1.0.0'])).toBeNull();
    expect(newestTag('1.4.1', ['1.4.0', '1.4.1'])).toBeNull();
  });
});

describe('shapes', () => {
  it('replaces numbers and recognises floating tags', () => {
    expect(shapeOf('v1.4.2-alpine3.19')).toBe('v#.#.#-alpine#.#');
    expect(isFloating('latest')).toBe(true);
    expect(isFloating('8')).toBe(false);
  });
});
