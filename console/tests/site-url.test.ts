import { describe, expect, it } from 'vitest';
import { siteUrl } from '@/lib/site-url';

describe('siteUrl', () => {
  it('leaves the port out on the standard ports', () => {
    expect(siteUrl({ host: 'a.example.com', ssl: false })).toBe(
      'http://a.example.com',
    );
    expect(siteUrl({ host: 'a.example.com', ssl: true })).toBe(
      'https://a.example.com',
    );
  });
  it('adds the proxy port when it is not standard', () => {
    const ports = { http: 8080, https: 8443 };
    expect(siteUrl({ host: 'a.localhost', ssl: false }, ports)).toBe(
      'http://a.localhost:8080',
    );
    expect(siteUrl({ host: 'a.localhost', ssl: true }, ports)).toBe(
      'https://a.localhost:8443',
    );
  });
  it('uses the port that matches the scheme', () => {
    expect(
      siteUrl({ host: 'a.org', ssl: true }, { http: 8080, https: 443 }),
    ).toBe('https://a.org');
  });
});
