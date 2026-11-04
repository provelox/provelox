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
    // Change the bytes themselves. Editing the text is not enough: the last character of the encoding carries unused
    // bits, so replacing it can decode to the very same bytes (about one run in a thousand), and that opens fine.
    const flipped = (at: number) => {
      const bytes = Buffer.from(sealed, 'base64url');
      bytes[at < 0 ? bytes.length + at : at] ^= 0xff;
      return bytes.toString('base64url');
    };
    // the nonce, the authentication tag, and the value
    for (const at of [0, 12, 27, -1]) expect(box.open(flipped(at))).toBeNull();
    expect(box.open(sealed.slice(0, -4))).toBeNull();
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
