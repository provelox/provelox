import {
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { Db } from '../db/db';
import { CiKeysService } from './ci-keys.service';

const make = () => new CiKeysService(new Db(':memory:'));
const bearer = (k: string) => `Bearer ${k}`;

describe('CiKeysService', () => {
  it('creates a key shown once and stores only a hash', () => {
    const db = new Db(':memory:');
    const s = new CiKeysService(db);
    const { key, info } = s.create(
      'site',
      'GitHub Actions',
      'ghcr.io/acme/site',
    );
    expect(key).toMatch(/^pvxk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(info).toMatchObject({
      app: 'site',
      name: 'GitHub Actions',
      repository: 'ghcr.io/acme/site',
      lastUsedAt: null,
    });
    // the secret is base64url, which can itself contain "_": take everything after the id
    const secret = key.split('_').slice(2).join('_');
    expect(
      JSON.stringify(db.raw.prepare('SELECT * FROM ci_keys').all()),
    ).not.toContain(secret);
    expect(JSON.stringify(s.list())).not.toContain(secret);
  });

  it('authenticates the right key and tells you which app it is for', () => {
    const s = make();
    const { key } = s.create('site', 'ci', 'ghcr.io/acme/site');
    expect(s.authenticate(bearer(key), '1.1.1.1').app).toBe('site');
  });

  it('rejects wrong, malformed and missing keys the same way', () => {
    const s = make();
    const { key } = s.create('site', 'ci', 'ghcr.io/acme/site');
    const tampered = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
    for (const h of [
      bearer(tampered),
      bearer('nope'),
      'Basic abc',
      '',
      undefined,
      bearer(`pvxk_${'0'.repeat(16)}_${'a'.repeat(43)}`),
    ])
      expect(() => s.authenticate(h, '1.1.1.1')).toThrow(
        new UnauthorizedError('Invalid API key'),
      );
  });

  it('stops working once revoked', () => {
    const s = make();
    const { key, info } = s.create('site', 'ci', 'ghcr.io/acme/site');
    s.revoke(info.id);
    expect(() => s.authenticate(bearer(key), 'x')).toThrow(UnauthorizedError);
    expect(() => s.revoke(info.id)).toThrow(NotFoundError);
  });

  it('removes all keys of an app', () => {
    const s = make();
    s.create('a', 'k1', 'ghcr.io/acme/a');
    s.create('b', 'k2', 'ghcr.io/acme/b');
    s.removeForApp('a');
    expect(s.list().map((k) => k.app)).toEqual(['b']);
  });

  it('slows down an address that keeps failing, without affecting others', () => {
    const s = make();
    const { key } = s.create('site', 'ci', 'ghcr.io/acme/site');
    for (let i = 0; i < 20; i++)
      expect(() => s.authenticate('Bearer bad', '9.9.9.9', 1000)).toThrow(
        UnauthorizedError,
      );
    expect(() => s.authenticate(bearer(key), '9.9.9.9', 1001)).toThrow(
      TooManyRequestsError,
    );
    expect(s.authenticate(bearer(key), '8.8.8.8', 1001).app).toBe('site');
    // the window passes
    expect(s.authenticate(bearer(key), '9.9.9.9', 1000 + 61_000).app).toBe(
      'site',
    );
  });

  it('records use and validates names', () => {
    const s = make();
    const { info } = s.create('site', 'ci', 'ghcr.io/acme/site');
    s.recordUse(info.id, 'acme/site:9');
    expect(s.list('site')[0]).toMatchObject({ lastUsedImage: 'acme/site:9' });
    expect(s.list('site')[0].lastUsedAt).not.toBeNull();
    expect(() => s.create('site', '  ', 'ghcr.io/acme/site')).toThrow(
      ValidationError,
    );
    expect(() => s.create('site', 'x'.repeat(61), 'ghcr.io/acme/site')).toThrow(
      ValidationError,
    );
  });
});
