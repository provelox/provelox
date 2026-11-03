import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox(
    'a-long-server-secret-a-long-server-secret',
    'registries',
  );

  it('round-trips and never contains the plain value', () => {
    const sealed = box.seal('p@ssw0rd');
    expect(sealed).not.toContain('p@ssw0rd');
    expect(box.open(sealed)).toBe('p@ssw0rd');
  });
  it('seals the same value differently each time', () => {
    expect(box.seal('x')).not.toBe(box.seal('x'));
  });
  it('fails to open tampered or foreign values', () => {
    const sealed = box.seal('x');
    expect(box.open(`${sealed.slice(0, -2)}AA`)).toBeNull();
    expect(box.open('garbage')).toBeNull();
    expect(
      new SecretBox('another-secret-another-secret-another', 'registries').open(
        sealed,
      ),
    ).toBeNull();
  });
  it('separates purposes', () => {
    const sealed = box.seal('x');
    expect(
      new SecretBox('a-long-server-secret-a-long-server-secret', 'other').open(
        sealed,
      ),
    ).toBeNull();
  });
  it('handles unicode', () => {
    expect(box.open(box.seal('pässwörd✓'))).toBe('pässwörd✓');
  });
});
