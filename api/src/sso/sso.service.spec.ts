import { makeStack } from '../test-utils';
import { isAllowed } from './providers';
import { safeReturnPath, type Fetcher } from './sso.service';

const ISSUER = 'https://idp.test';
const ENV = {
  API_PUBLIC_URL: 'https://api.example.com',
  ERROR_PAGES_SERVICE: 'pvx_error_pages@swarm',
};

/** An identity provider that answers like OpenID Connect, signing in whoever `who` currently is */
const provider = (who: { email: string; verified?: boolean }) => {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url);
    const json = (body: unknown, ok = true) => ({
      ok,
      status: ok ? 200 : 400,
      json: async () => body,
    });
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return json({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
      });
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(init?.body);
      if (body.get('client_secret') !== 's3cret' || !body.get('code_verifier'))
        return json({}, false);
      return json({ access_token: 'at' });
    }
    if (url === `${ISSUER}/userinfo`)
      return json({
        email: who.email,
        email_verified: who.verified ?? true,
        name: 'Ada',
      });
    return json({}, false);
  };
  return { fetcher, calls };
};

const setup = async (
  who = { email: 'ada@corp.com' } as { email: string; verified?: boolean },
) => {
  const s = makeStack(ENV);
  const idp = provider(who);
  s.sso.fetcher = idp.fetcher;
  await s.sso.save('idp', {
    kind: 'oidc',
    label: 'Company',
    clientId: 'cid',
    clientSecret: 's3cret',
    issuer: ISSUER,
  });
  await s.apps.create({ name: 'site' });
  await s.apps.update('site', {
    sso: { provider: 'idp', emails: ['bob@other.com'], domains: ['corp.com'] },
  });
  return { ...s, idp, who };
};

/** Walks the browser through the whole sign-in and returns the session cookie, or what stopped it */
const signIn = async (
  s: Awaited<ReturnType<typeof setup>>,
  now = Date.now(),
) => {
  const app = s.repo.get('site')!;
  const { url, nonce } = await s.sso.start(
    app,
    'site.example.com',
    'https',
    '/reports?x=1',
    now,
  );
  const state = new URL(url).searchParams.get('state')!;
  const back = await s.sso.callback('code', state, now);
  if (!back.ok) return { back };
  const token = new URL(back.url).searchParams.get('t')!;
  return { back, token, nonce, url };
};

describe('isAllowed', () => {
  const rules = { emails: ['Bob@Other.com'], domains: ['corp.com'] };
  it('matches an address or a whole domain, ignoring case', () => {
    expect(isAllowed(rules, 'bob@other.com')).toBe(true);
    expect(isAllowed(rules, 'ADA@CORP.COM')).toBe(true);
  });
  it('does not match another domain, a subdomain or a lookalike', () => {
    expect(isAllowed(rules, 'ada@evilcorp.com')).toBe(false);
    expect(isAllowed(rules, 'ada@mail.corp.com')).toBe(false);
    expect(isAllowed(rules, 'ada@corp.com.evil.io')).toBe(false);
    expect(isAllowed(rules, 'corp.com')).toBe(false);
  });
});

describe('safeReturnPath', () => {
  it('keeps a path on the same site', () => {
    expect(safeReturnPath('/reports?x=1')).toBe('/reports?x=1');
  });
  it('never leaves the site or loops through the sign-in pages', () => {
    for (const bad of [
      'https://evil.io',
      '//evil.io',
      '/\\evil.io',
      '/.pvx-auth/login',
      '/a\r\nSet-Cookie: x=1',
      undefined,
      42,
    ])
      expect(safeReturnPath(bad)).toBe('/');
  });
});

describe('SsoService providers', () => {
  it('keeps the client secret sealed and never returns it', async () => {
    const s = await setup();
    const stored = JSON.stringify(s.settings.get('sso.providers'));
    expect(stored).not.toContain('s3cret');
    expect(JSON.stringify(s.sso.list())).not.toContain('secret');
  });

  it('keeps the saved secret when an edit leaves it out', async () => {
    const s = await setup();
    await s.sso.save('idp', {
      kind: 'oidc',
      label: 'Renamed',
      clientId: 'cid',
      issuer: ISSUER,
    });
    const { url } = await s.sso.start(
      s.repo.get('site')!,
      'site.example.com',
      'https',
      '/',
    );
    const back = await s.sso.callback(
      'c',
      new URL(url).searchParams.get('state')!,
    );
    expect(back.ok).toBe(true);
  });

  it('refuses an issuer that does not publish its endpoints', async () => {
    const s = makeStack(ENV);
    s.sso.fetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    await expect(
      s.sso.save('idp', {
        kind: 'oidc',
        label: 'X',
        clientId: 'c',
        clientSecret: 's',
        issuer: ISSUER,
      }),
    ).rejects.toThrow(/endpoints/);
  });

  it('will not fetch an issuer that points at a metadata address', async () => {
    const s = makeStack(ENV);
    const calls: string[] = [];
    s.sso.fetcher = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await expect(
      s.sso.save('idp', {
        kind: 'oidc',
        label: 'X',
        clientId: 'c',
        clientSecret: 's',
        issuer: 'http://169.254.169.254',
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('will not remove a provider an app still uses', async () => {
    const s = await setup();
    expect(() => s.sso.remove('idp')).toThrow(/site/);
    await s.apps.update('site', { sso: null });
    s.sso.remove('idp');
    expect(s.sso.list()).toEqual([]);
  });

  it('suggests an unused id', async () => {
    const s = await setup();
    expect(s.sso.freeId('Company', 'oidc')).toBe('company');
    expect(s.sso.freeId('idp', 'google')).toBe('idp-2');
  });
});

describe('apps that ask for a sign-in', () => {
  it('needs the API at its own address', async () => {
    const s = makeStack();
    await s.apps.create({ name: 'site' });
    await expect(
      s.apps.update('site', { sso: { provider: 'x', emails: ['a@b.co'] } }),
    ).rejects.toThrow(/API_PUBLIC_URL/);
  });

  it('needs an existing provider and someone allowed in', async () => {
    const s = makeStack(ENV);
    await s.apps.create({ name: 'site' });
    await expect(
      s.apps.update('site', { sso: { provider: 'nope', emails: ['a@b.co'] } }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      s.apps.update('site', { sso: { provider: 'nope' } }),
    ).rejects.toThrow(/who may sign in/);
  });
});

describe('the sign-in', () => {
  it('sends the visitor to the provider with a PKCE challenge and a sealed state', async () => {
    const s = await setup();
    const { url } = await s.sso.start(
      s.repo.get('site')!,
      'site.example.com',
      'https',
      '/',
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/internal/sso/callback',
    );
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).not.toContain('site');
  });

  it('knows the app’s address when the browser used a port', async () => {
    const s = await setup();
    const app = s.repo.get('site')!;
    expect(s.sso.ownsHost(app, 'site.example.com:18080')).toBe(true);
    expect(s.sso.ownsHost(app, 'SITE.example.com')).toBe(true);
    expect(s.sso.ownsHost(app, 'evil.io:80')).toBe(false);
    expect(s.sso.ownsHost(app, 'site.example.com.evil.io')).toBe(false);
  });

  it('only returns to an address the app has', async () => {
    const s = await setup();
    await expect(
      s.sso.start(s.repo.get('site')!, 'evil.io', 'https', '/'),
    ).rejects.toThrow();
  });

  it('lets in someone the rules allow and sets a cookie that works only for that app', async () => {
    const s = await setup();
    const r = await signIn(s);
    expect(r.back.ok).toBe(true);
    const done = s.sso.finish('site', r.token!, r.nonce);
    expect(done.rd).toBe('/reports?x=1');
    const app = s.repo.get('site')!;
    expect(s.sso.check(app, done.cookie)).toEqual({
      email: 'ada@corp.com',
      name: 'Ada',
    });
    expect(s.sso.check({ ...app, name: 'other' }, done.cookie)).toBeNull();
    expect(s.sso.check(app, undefined)).toBeNull();
    expect(s.sso.check(app, done.cookie + 'x')).toBeNull();
  });

  it('refuses someone the rules do not allow', async () => {
    const s = await setup({ email: 'eve@evil.io' });
    const r = await signIn(s);
    expect(r.back).toMatchObject({ ok: false, email: 'eve@evil.io' });
  });

  it('refuses an address the provider has not verified', async () => {
    const s = await setup({ email: 'ada@corp.com', verified: false });
    await expect(signIn(s)).rejects.toThrow(/verified email/);
  });

  it('will not finish in a browser that did not start the sign-in', async () => {
    const s = await setup();
    const r = await signIn(s);
    expect(() =>
      s.sso.finish('site', r.token!, 'someone-elses-nonce'),
    ).toThrow();
    expect(() => s.sso.finish('site', r.token!, undefined)).toThrow();
  });

  it('will not finish for another app, or after the token expired', async () => {
    const s = await setup();
    const r = await signIn(s);
    expect(() => s.sso.finish('other', r.token!, r.nonce)).toThrow();
    expect(() =>
      s.sso.finish('site', r.token!, r.nonce, Date.now() + 61_000),
    ).toThrow();
  });

  it('rejects a state that is forged or too old', async () => {
    const s = await setup();
    await expect(s.sso.callback('c', 'forged')).rejects.toThrow();
    const { url } = await s.sso.start(
      s.repo.get('site')!,
      'site.example.com',
      'https',
      '/',
    );
    const state = new URL(url).searchParams.get('state')!;
    await expect(
      s.sso.callback('c', state, Date.now() + 11 * 60_000),
    ).rejects.toThrow(/too long/);
  });

  it('takes effect at once when the rules change', async () => {
    const s = await setup();
    const r = await signIn(s);
    const { cookie } = s.sso.finish('site', r.token!, r.nonce);
    await s.apps.update('site', {
      sso: { provider: 'idp', emails: ['bob@other.com'], domains: [] },
    });
    expect(s.sso.check(s.repo.get('site')!, cookie)).toBeNull();
  });

  it('expires the session', async () => {
    const s = await setup();
    const r = await signIn(s);
    const { cookie } = s.sso.finish('site', r.token!, r.nonce);
    const later = Date.now() + 13 * 3600_000;
    expect(s.sso.check(s.repo.get('site')!, cookie, later)).toBeNull();
  });
});
