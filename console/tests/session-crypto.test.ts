import { describe, expect, it } from 'vitest';
import { openSession, sealSession } from '@/lib/session-crypto';

const secret = 'x'.repeat(40);

describe('session cookie', () => {
  it('round-trips', () => {
    const sealed = sealSession(
      { token: 'tok', exp: Date.now() + 1000 },
      secret,
    );
    expect(openSession(sealed, secret)?.token).toBe('tok');
  });
  it('hides the token', () => {
    expect(
      sealSession(
        { token: 'super-secret-token', exp: Date.now() + 1000 },
        secret,
      ),
    ).not.toContain('super-secret');
  });
  it('rejects expiry, wrong secret, tampering and garbage', () => {
    const sealed = sealSession({ token: 'tok', exp: 1000 }, secret);
    expect(openSession(sealed, secret, 2000)).toBeNull();
    const fresh = sealSession({ token: 'tok', exp: Date.now() + 1000 }, secret);
    expect(openSession(fresh, 'y'.repeat(40))).toBeNull();
    const parts = fresh.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(openSession(parts.join('.'), secret)).toBeNull();
    expect(openSession('garbage', secret)).toBeNull();
    expect(openSession(undefined, secret)).toBeNull();
  });
});
