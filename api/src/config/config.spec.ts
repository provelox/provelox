import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';

const base = { JWT_SECRET: 'x'.repeat(40) };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      PORT: 4000,
      PROXY_ENABLED: true,
      PROXY_HTTP_PORT: 80,
      TRAEFIK_IMAGE: 'traefik:v3.6',
    });
  });
  it('requires a long JWT secret', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
  });
  it('treats empty variables as unset', () => {
    expect(
      loadConfig({ ...base, ACME_EMAIL: '', ROOT_DOMAIN: '' }).ACME_EMAIL,
    ).toBeUndefined();
  });
  it('reads *_FILE variables (Docker secrets)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pvx-cfg-'));
    writeFileSync(path.join(dir, 'jwt'), `${'s'.repeat(40)}\n`);
    expect(
      loadConfig({ JWT_SECRET_FILE: path.join(dir, 'jwt') }).JWT_SECRET,
    ).toBe('s'.repeat(40));
  });
  it('lets a plain variable win over its _FILE', () => {
    expect(
      loadConfig({
        JWT_SECRET: 'p'.repeat(40),
        JWT_SECRET_FILE: '/does/not/matter',
      }).JWT_SECRET,
    ).toBe('p'.repeat(40));
  });
  it('explains an unreadable _FILE', () => {
    expect(() => loadConfig({ JWT_SECRET_FILE: '/nope/missing' })).toThrow(
      /JWT_SECRET_FILE points to \/nope\/missing/,
    );
  });
  it('parses booleans and ports', () => {
    const c = loadConfig({
      ...base,
      PROXY_ENABLED: 'false',
      PROXY_HTTP_PORT: '8080',
    });
    expect(c.PROXY_ENABLED).toBe(false);
    expect(c.PROXY_HTTP_PORT).toBe(8080);
    expect(() => loadConfig({ ...base, PROXY_HTTP_PORT: '99999' })).toThrow();
  });
});
