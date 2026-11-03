import { parseImageRef } from './image-ref';
import { RegistryClient, RegistryError, realmAllowed } from './registry-client';

const ref = (s: string) => parseImageRef(s)!;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('realmAllowed', () => {
  it('follows the registry’s own token service and nothing else', () => {
    expect(
      realmAllowed('https://auth.docker.io/token', 'registry-1.docker.io'),
    ).toBe(true);
    expect(realmAllowed('https://ghcr.io/token', 'ghcr.io')).toBe(true);
    expect(realmAllowed('https://evil.example.net/token', 'ghcr.io')).toBe(
      false,
    );
    expect(
      realmAllowed('http://auth.docker.io/token', 'registry-1.docker.io'),
    ).toBe(false);
    expect(
      realmAllowed('https://169.254.169.254/token', '169.254.169.254'),
    ).toBe(false);
    expect(realmAllowed('not a url', 'ghcr.io')).toBe(false);
  });
  it('lets a local registry use itself, over http', () => {
    expect(realmAllowed('http://localhost:5001/token', 'localhost:5001')).toBe(
      true,
    );
    expect(realmAllowed('http://10.0.0.5/token', 'localhost:5001')).toBe(false);
  });
});

describe('a registry that wants a sign-in', () => {
  const guarded = (async (url: string | URL) =>
    String(url).includes('/token')
      ? new Response('', { status: 401 })
      : new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        })) as unknown as typeof fetch;
  it('says to add one when there is none, and that it was refused when there is', async () => {
    await expect(
      new RegistryClient(guarded).tags(ref('ghcr.io/a/b:1')),
    ).rejects.toThrow(/needs a sign-in.*Registries/);
    await expect(
      new RegistryClient(guarded).tags(ref('ghcr.io/a/b:1'), {
        username: 'u',
        password: 'p',
      }),
    ).rejects.toThrow(/did not accept the saved sign-in/);
  });
});

describe('RegistryClient', () => {
  it('does the bearer handshake once and lists every page of tags', async () => {
    const calls: string[] = [];
    const fetcher = jest.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.startsWith('https://auth.docker.io/token'))
        return json({ token: 'tok' });
      const auth = (init?.headers as Record<string, string> | undefined)
        ?.Authorization;
      if (auth !== 'Bearer tok')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
          },
        });
      if (u.includes('last=b')) return json({ tags: ['c'] });
      return json(
        { tags: ['a', 'b'] },
        {
          headers: {
            link: '</v2/library/nginx/tags/list?last=b&n=1000>; rel="next"',
          },
        },
      );
    }) as unknown as typeof fetch;
    const client = new RegistryClient(fetcher);
    expect(await client.tags(ref('nginx'))).toEqual(['a', 'b', 'c']);
    expect(calls.filter((c) => c.includes('auth.docker.io'))).toHaveLength(1);
  });

  it('sends the saved sign-in to the token service', async () => {
    let seen: string | undefined;
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://ghcr.io/token')) {
        seen = (init?.headers as Record<string, string>).Authorization;
        return json({ token: 't' });
      }
      const auth = (init?.headers as Record<string, string> | undefined)
        ?.Authorization;
      return auth
        ? json({ tags: ['1'] })
        : new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
            },
          });
    }) as unknown as typeof fetch;
    await new RegistryClient(fetcher).tags(ref('ghcr.io/a/b:1'), {
      username: 'u',
      password: 'p',
    });
    expect(seen).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('refuses to follow a token address that is not the registry’s', async () => {
    const fetcher = (async () =>
      new Response('', {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer realm="https://evil.example.net/token"',
        },
      })) as unknown as typeof fetch;
    await expect(
      new RegistryClient(fetcher).tags(ref('ghcr.io/a/b:1')),
    ).rejects.toThrow(/does not own/);
  });

  it('reads the digest from the header of a HEAD request', async () => {
    const d = 'sha256:' + 'c'.repeat(64);
    const fetcher = jest.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { 'docker-content-digest': d },
        }),
    ) as unknown as typeof fetch;
    expect(
      await new RegistryClient(fetcher).digest(ref('acme/web:1'), '1'),
    ).toBe(d);
    expect((fetcher as jest.Mock).mock.calls[0][1].method).toBe('HEAD');
  });

  it('says plainly what went wrong', async () => {
    const status = (s: number) =>
      new RegistryClient(
        (async () =>
          new Response('', { status: s })) as unknown as typeof fetch,
      );
    await expect(status(404).tags(ref('acme/gone'))).rejects.toThrow(
      /has no acme\/gone/,
    );
    await expect(status(403).tags(ref('acme/priv'))).rejects.toThrow(
      /Add its sign-in/,
    );
    await expect(status(500).tags(ref('acme/x'))).rejects.toBeInstanceOf(
      RegistryError,
    );
    expect(await status(404).digest(ref('acme/x:1'), '1')).toBeNull();
  });

  it('falls back to http for a local registry only', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).startsWith('https://')) throw new Error('ECONNREFUSED');
      return json({ tags: ['t'] });
    }) as unknown as typeof fetch;
    expect(
      await new RegistryClient(fetcher).tags(ref('localhost:5001/provelox:t')),
    ).toEqual(['t']);
    expect(urls[1].startsWith('http://localhost:5001')).toBe(true);
    const remote = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(
      new RegistryClient(remote).tags(ref('ghcr.io/a/b:1')),
    ).rejects.toThrow(/Could not reach/);
  });
});
