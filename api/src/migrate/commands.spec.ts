import { assertDurable } from './commands';

describe('assertDurable', () => {
  it('refuses a container run from the image folder without mounted paths', () => {
    expect(() => assertDurable({}, true, '/app')).toThrow(/would be lost/);
    expect(() =>
      assertDurable({ 'state-file': '/x/s.json' }, true, '/app'),
    ).toThrow();
  });
  it('allows a mounted working folder, explicit paths, or a source checkout', () => {
    expect(() => assertDurable({}, true, '/work')).not.toThrow();
    expect(() =>
      assertDurable(
        { 'state-file': '/m/s.json', 'backup-dir': '/m/b' },
        true,
        '/app',
      ),
    ).not.toThrow();
    expect(() => assertDurable({}, false, '/app')).not.toThrow();
  });
});
