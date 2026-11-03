import { scopeAllows } from './scope.decorator';
import {
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { Db } from '../db/db';
import { AccessTokensService } from './access-tokens.service';

const make = () => new AccessTokensService(new Db(':memory:'));

describe('AccessTokensService', () => {
  it('creates a token shown once and stores only a hash', () => {
    const db = new Db(':memory:');
    const s = new AccessTokensService(db);
    const { token, info } = s.create('hub', 'read');
    expect(token).toMatch(/^pvxt_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(info).toMatchObject({
      name: 'hub',
      scope: 'read',
      lastUsedAt: null,
    });
    const secret = token.split('_').slice(2).join('_');
    expect(
      JSON.stringify(db.raw.prepare('SELECT * FROM access_tokens').all()),
    ).not.toContain(secret);
    expect(JSON.stringify(s.list())).not.toContain(secret);
  });

  it('authenticates the right token and reports its scope', () => {
    const s = make();
    const { token } = s.create('hub', 'operate');
    expect(s.authenticate(token, '1.1.1.1').scope).toBe('operate');
  });

  it('rejects wrong and malformed tokens the same way', () => {
    const s = make();
    const { token } = s.create('hub', 'read');
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const t of [
      tampered,
      'pvxt_nope',
      `pvxt_${'0'.repeat(16)}_${'a'.repeat(43)}`,
    ])
      expect(() => s.authenticate(t, '1.1.1.1')).toThrow(
        new UnauthorizedError('Invalid token'),
      );
  });

  it('stops working once revoked', () => {
    const s = make();
    const { token, info } = s.create('hub', 'read');
    s.revoke(info.id);
    expect(() => s.authenticate(token, '1.1.1.1')).toThrow(UnauthorizedError);
    expect(() => s.revoke(info.id)).toThrow(NotFoundError);
  });

  it('slows down an address that keeps failing', () => {
    const s = make();
    const bad = `pvxt_${'0'.repeat(16)}_${'a'.repeat(43)}`;
    for (let i = 0; i < 20; i++)
      expect(() => s.authenticate(bad, '9.9.9.9', 1000)).toThrow(
        UnauthorizedError,
      );
    expect(() => s.authenticate(bad, '9.9.9.9', 2000)).toThrow(
      TooManyRequestsError,
    );
    // a minute later it is allowed to try again
    expect(() => s.authenticate(bad, '9.9.9.9', 62_000)).toThrow(
      UnauthorizedError,
    );
  });

  it('records use at most once a minute', () => {
    const s = make();
    const { token, info } = s.create('hub', 'read');
    s.authenticate(token, 'x', 1_000_000);
    const first = s.list().find((t) => t.id === info.id)?.lastUsedAt;
    expect(first).toBe(new Date(1_000_000).toISOString());
    s.authenticate(token, 'x', 1_010_000);
    expect(s.list().find((t) => t.id === info.id)?.lastUsedAt).toBe(first);
    s.authenticate(token, 'x', 1_070_000);
    expect(s.list().find((t) => t.id === info.id)?.lastUsedAt).toBe(
      new Date(1_070_000).toISOString(),
    );
  });

  it('needs a name and a sensible length', () => {
    const s = make();
    expect(() => s.create('  ', 'read')).toThrow(ValidationError);
    expect(() => s.create('x'.repeat(61), 'read')).toThrow(ValidationError);
  });
});

describe('scopeAllows', () => {
  it('lets each scope do what the ones before it can', () => {
    expect(scopeAllows('read', 'read')).toBe(true);
    expect(scopeAllows('read', 'operate')).toBe(false);
    expect(scopeAllows('operate', 'read')).toBe(true);
    expect(scopeAllows('operate', 'update')).toBe(false);
    expect(scopeAllows('update', 'operate')).toBe(true);
    expect(scopeAllows('update', 'update')).toBe(true);
  });
});
