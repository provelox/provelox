import { hostsOf, routingLabels } from './traefik-labels';
import { makeApp } from '../apps/test-fixtures';

const ctx = {
  rootDomain: 'example.com',
  certResolver: 'le',
  errorPagesService: null as string | null,
};

describe('hostsOf', () => {
  it('lists the default subdomain first, then custom domains', () => {
    const app = makeApp({ domains: [{ host: 'site.org', ssl: true }] });
    expect(hostsOf(app, 'example.com')).toEqual([
      { host: 'my-app.example.com', ssl: false },
      { host: 'site.org', ssl: true },
    ]);
  });
  it('honours the custom-domains-only switch', () => {
    const app = makeApp({
      defaultSubdomain: false,
      domains: [{ host: 'site.org', ssl: false }],
    });
    expect(hostsOf(app, 'example.com').map((h) => h.host)).toEqual([
      'site.org',
    ]);
  });
  it('has no hosts when the app is not exposed or no root domain exists', () => {
    expect(hostsOf(makeApp({ exposed: false }), 'example.com')).toEqual([]);
    expect(hostsOf(makeApp(), null)).toEqual([]);
  });
});

describe('routingLabels', () => {
  it('disables routing for apps without hosts', () => {
    expect(routingLabels(makeApp({ exposed: false }), ctx)).toEqual({
      'traefik.enable': 'false',
    });
  });

  it('routes plain HTTP hosts on the web entrypoint to the container port', () => {
    const l = routingLabels(makeApp({ containerPort: 3000 }), ctx);
    expect(l['traefik.http.routers.my-app-web.rule']).toBe(
      'Host(`my-app.example.com`)',
    );
    expect(l['traefik.http.routers.my-app-web.entrypoints']).toBe('web');
    expect(l['traefik.http.services.my-app.loadbalancer.server.port']).toBe(
      '3000',
    );
    expect(l['traefik.swarm.network']).toBe('provelox-net');
    // Traefik skips services that mix Swarm and Docker labels
    expect(Object.keys(l).some((k) => k.startsWith('traefik.docker.'))).toBe(
      false,
    );
    expect(Object.keys(l).some((k) => k.includes('websecure'))).toBe(false);
  });

  it('adds a certificate-backed websecure router for HTTPS hosts', () => {
    const l = routingLabels(makeApp({ defaultSubdomainSsl: true }), ctx);
    expect(l['traefik.http.routers.my-app-websecure.entrypoints']).toBe(
      'websecure',
    );
    expect(l['traefik.http.routers.my-app-websecure.tls.certresolver']).toBe(
      'le',
    );
    // not forced: the HTTP router still answers the same host
    expect(l['traefik.http.routers.my-app-web.rule']).toContain(
      'my-app.example.com',
    );
  });

  it('redirects HTTPS hosts to HTTPS when SSL is forced, leaving plain hosts alone', () => {
    const l = routingLabels(
      makeApp({
        forceSsl: true,
        defaultSubdomainSsl: true,
        domains: [{ host: 'plain.org', ssl: false }],
      }),
      ctx,
    );
    expect(l['traefik.http.routers.my-app-redirect.rule']).toBe(
      'Host(`my-app.example.com`)',
    );
    expect(l['traefik.http.routers.my-app-redirect.middlewares']).toBe(
      'my-app-https',
    );
    expect(
      l['traefik.http.middlewares.my-app-https.redirectscheme.scheme'],
    ).toBe('https');
    expect(l['traefik.http.routers.my-app-web.rule']).toBe('Host(`plain.org`)');
  });

  describe('custom error pages', () => {
    const pages = { errorPages: { '502': '<h1>down</h1>' } };
    const withService = { ...ctx, errorPagesService: 'pvx-api-errors@swarm' };

    it('adds an errors middleware pointing at the page endpoint', () => {
      const l = routingLabels(makeApp(pages), withService);
      expect(l['traefik.http.middlewares.my-app-errors.errors.status']).toBe(
        '502-504',
      );
      expect(l['traefik.http.middlewares.my-app-errors.errors.service']).toBe(
        'pvx-api-errors@swarm',
      );
      expect(l['traefik.http.middlewares.my-app-errors.errors.query']).toBe(
        '/internal/error-pages/my-app/{status}',
      );
      expect(l['traefik.http.routers.my-app-web.middlewares']).toBe(
        'my-app-errors',
      );
    });
    it('is on for every app, so one without its own pages shows the branded default', () => {
      const l = routingLabels(makeApp(), withService);
      expect(l['traefik.http.middlewares.my-app-errors.errors.status']).toBe(
        '502-504',
      );
      expect(l['traefik.http.routers.my-app-web.middlewares']).toBe(
        'my-app-errors',
      );
    });
    it('is absent without a page service', () => {
      expect(
        Object.keys(routingLabels(makeApp(pages), ctx)).some((k) =>
          k.includes('errors'),
        ),
      ).toBe(false);
    });
    it('goes on the HTTPS router too, but not on the redirect router', () => {
      const l = routingLabels(
        makeApp({ ...pages, defaultSubdomainSsl: true, forceSsl: true }),
        withService,
      );
      expect(l['traefik.http.routers.my-app-websecure.middlewares']).toBe(
        'my-app-errors',
      );
      expect(l['traefik.http.routers.my-app-redirect.middlewares']).toBe(
        'my-app-https',
      );
    });
  });

  it('joins several hosts in one rule', () => {
    const l = routingLabels(
      makeApp({ domains: [{ host: 'a.org', ssl: false }] }),
      ctx,
    );
    expect(l['traefik.http.routers.my-app-web.rule']).toBe(
      'Host(`my-app.example.com`) || Host(`a.org`)',
    );
  });
});

describe('routingLabels: primary address', () => {
  const app = makeApp({
    defaultSubdomainSsl: true,
    domains: [
      { host: 'www.site.org', ssl: true },
      { host: 'site.org', ssl: false },
    ],
    primaryDomain: 'www.site.org',
  });
  const l = routingLabels(app, ctx);

  it('serves the app only on the primary address', () => {
    expect(l['traefik.http.routers.my-app-websecure.rule']).toBe(
      'Host(`www.site.org`)',
    );
    expect(l['traefik.http.routers.my-app-web.rule']).toBe(
      'Host(`www.site.org`)',
    );
  });
  it('redirects every other address to it in one hop, keeping path and query', () => {
    expect(l['traefik.http.routers.my-app-moved.rule']).toBe(
      'Host(`my-app.example.com`) || Host(`site.org`)',
    );
    expect(l['traefik.http.routers.my-app-moved.middlewares']).toBe(
      'my-app-primary',
    );
    expect(
      l['traefik.http.middlewares.my-app-primary.redirectregex.regex'],
    ).toBe('^https?://[^/]+/?(.*)');
    expect(
      l['traefik.http.middlewares.my-app-primary.redirectregex.replacement'],
    ).toBe('https://www.site.org/${1}');
    expect(
      l['traefik.http.middlewares.my-app-primary.redirectregex.permanent'],
    ).toBe('true');
  });
  it('still gets a certificate for an old HTTPS address so its redirect can be reached', () => {
    const key = 'traefik.http.routers.my-app-moved-secure';
    expect(l[`${key}.rule`]).toBe('Host(`my-app.example.com`)');
    expect(l[`${key}.tls.certresolver`]).toBe('le');
  });
  it('redirects to http when the primary has no HTTPS', () => {
    const plain = routingLabels(
      makeApp({
        domains: [{ host: 'site.org', ssl: false }],
        primaryDomain: 'site.org',
      }),
      ctx,
    );
    expect(
      plain[
        'traefik.http.middlewares.my-app-primary.redirectregex.replacement'
      ],
    ).toBe('http://site.org/${1}');
  });
  it('behaves as before when the primary address is not one of the hosts', () => {
    const stale = routingLabels(makeApp({ primaryDomain: 'gone.org' }), ctx);
    expect(stale['traefik.http.routers.my-app-moved.rule']).toBeUndefined();
    expect(stale['traefik.http.routers.my-app-web.rule']).toBe(
      'Host(`my-app.example.com`)',
    );
  });
});

describe('routingLabels with HTTP basic auth', () => {
  const hash = '$2a$08$' + 'a'.repeat(53);
  const secured = (over = {}) =>
    makeApp({
      defaultSubdomainSsl: true,
      forceSsl: true,
      basicAuth: {
        users: [
          { name: 'secure', hash },
          { name: 'ops', hash },
        ],
        openPaths: [],
      },
      ...over,
    });
  const labelsOf = (app = secured()) =>
    routingLabels(app, { ...ctx, errorPagesService: 'pvx-api-errors@swarm' });

  it('defines the password middleware from the saved hashes, and does not pass the credentials on', () => {
    const l = labelsOf();
    expect(l['traefik.http.middlewares.my-app-auth.basicauth.users']).toBe(
      `secure:${hash},ops:${hash}`,
    );
    expect(
      l['traefik.http.middlewares.my-app-auth.basicauth.removeheader'],
    ).toBe('true');
  });

  it('puts it in front of the routers that serve the app, before the error pages', () => {
    const l = labelsOf();
    expect(l['traefik.http.routers.my-app-websecure.middlewares']).toBe(
      'my-app-auth,my-app-errors',
    );
  });

  it('leaves the redirect to HTTPS without a password, so a plain request is sent to the secure address first', () => {
    const l = labelsOf();
    expect(l['traefik.http.routers.my-app-redirect.middlewares']).toBe(
      'my-app-https',
    );
  });

  it('adds nothing when no password is set', () => {
    const l = routingLabels(makeApp({ defaultSubdomainSsl: true }), ctx);
    expect(
      Object.keys(l).some(
        (k) => k.includes('basicauth') || k.includes('-open-'),
      ),
    ).toBe(false);
  });

  it('keeps chosen paths open with a router of their own that has a higher priority and no password', () => {
    const l = labelsOf(
      secured({
        basicAuth: {
          users: [{ name: 'secure', hash }],
          openPaths: ['/webhooks', '/health'],
        },
      }),
    );
    const rule = l['traefik.http.routers.my-app-open-websecure.rule'];
    expect(rule).toContain('Host(`my-app.example.com`)');
    expect(rule).toContain('PathPrefix(`/webhooks`) || PathPrefix(`/health`)');
    expect(l['traefik.http.routers.my-app-open-websecure.priority']).toBe(
      '100000',
    );
    expect(l['traefik.http.routers.my-app-open-websecure.middlewares']).toBe(
      'my-app-errors',
    );
    expect(
      l['traefik.http.routers.my-app-open-websecure.tls.certresolver'],
    ).toBe('le');
  });
});

describe('routingLabels behind a CDN', () => {
  const cdnCtx = {
    ...ctx,
    cdnRanges: { cloudfront: ['10.0.0.0/24', '2600:9000::/32'] },
  };
  const key = 'traefik.http.middlewares.my-app-cdn.ipallowlist.sourcerange';

  it('lets only the CDN through, ahead of the password and the error pages', () => {
    const l = routingLabels(
      makeApp({
        cdn: { provider: 'cloudfront', enforce: true },
        basicAuth: {
          users: [{ name: 'a', hash: '$2a$08$' + 'x'.repeat(53) }],
          openPaths: ['/hook'],
        },
        domains: [{ host: 'site.org', ssl: true }],
      }),
      { ...cdnCtx, errorPagesService: 'e@swarm' },
    );
    expect(l[key]).toBe('10.0.0.0/24,2600:9000::/32');
    expect(l['traefik.http.routers.my-app-web.middlewares']).toBe(
      'my-app-cdn,my-app-auth,my-app-errors',
    );
    expect(l['traefik.http.routers.my-app-websecure.middlewares']).toBe(
      'my-app-cdn,my-app-auth,my-app-errors',
    );
    // the open paths skip the password, never the CDN check
    expect(l['traefik.http.routers.my-app-open-websecure.middlewares']).toBe(
      'my-app-cdn,my-app-errors',
    );
  });

  it('guards the redirects too, so nothing answers around the CDN', () => {
    const l = routingLabels(
      makeApp({
        cdn: { provider: 'cloudfront', enforce: true },
        forceSsl: true,
        defaultSubdomain: false,
        primaryDomain: 'a.org',
        domains: [
          { host: 'a.org', ssl: true },
          { host: 'b.org', ssl: true },
        ],
      }),
      cdnCtx,
    );
    expect(l['traefik.http.routers.my-app-moved.middlewares']).toBe(
      'my-app-cdn,my-app-primary',
    );
    expect(l['traefik.http.routers.my-app-moved-secure.middlewares']).toBe(
      'my-app-cdn,my-app-primary',
    );
    expect(l['traefik.http.routers.my-app-redirect.middlewares']).toBe(
      'my-app-cdn,my-app-https',
    );
  });

  it.each([
    ['not enforced', { provider: 'cloudfront', enforce: false }, cdnCtx],
    ['no ranges known', { provider: 'cloudfront', enforce: true }, ctx],
    ['another CDN', { provider: 'fastly', enforce: true }, cdnCtx],
  ])('adds nothing when %s', (_n, cdn, c) => {
    expect(JSON.stringify(routingLabels(makeApp({ cdn }), c))).not.toContain(
      'ipallowlist',
    );
  });
});

describe('routingLabels with a sign-in', () => {
  const sso = {
    verifyUrl: 'http://pvx-provelox:4000',
    service: 'pvx_error_pages@swarm',
  };
  const app = makeApp({
    name: 'site',
    exposed: true,
    defaultSubdomain: true,
    defaultSubdomainSsl: true,
    sso: { provider: 'idp', emails: ['a@b.co'], domains: [], openPaths: [] },
  });
  const labels = routingLabels(app, { ...ctx, sso });

  it('asks the API about every request and passes on who signed in', () => {
    expect(
      labels['traefik.http.middlewares.site-sso.forwardauth.address'],
    ).toBe('http://pvx-provelox:4000/internal/sso/verify/site');
    expect(
      labels[
        'traefik.http.middlewares.site-sso.forwardauth.authresponseheaders'
      ],
    ).toBe('X-Provelox-User,X-Provelox-Email');
    expect(labels['traefik.http.routers.site-websecure.middlewares']).toBe(
      'site-sso',
    );
  });

  it('serves the sign-in pages from the API at the app address, ahead of the check', () => {
    const r = 'traefik.http.routers.site-sso-websecure';
    expect(labels[`${r}.rule`]).toContain('PathPrefix(`/.pvx-auth/`)');
    expect(labels[`${r}.service`]).toBe('pvx_error_pages@swarm');
    expect(Number(labels[`${r}.priority`])).toBeGreaterThan(100000);
    expect(labels[`${r}.middlewares`]).toBe('site-sso-path');
    expect(
      labels[
        'traefik.http.middlewares.site-sso-path.replacepathregex.replacement'
      ],
    ).toBe('/internal/sso/app/site/${1}');
  });

  it('is not served at all when the sign-in cannot be provided', () => {
    expect(routingLabels(app, ctx)).toEqual({ 'traefik.enable': 'false' });
  });

  it('leaves open paths without the check', () => {
    const open = routingLabels(
      { ...app, sso: { ...app.sso!, openPaths: ['/webhooks'] } },
      { ...ctx, sso },
    );
    const key = 'traefik.http.routers.site-open-websecure';
    expect(open[`${key}.rule`]).toContain('/webhooks');
    expect(open[`${key}.middlewares`]).toBeUndefined();
  });

  it('asks for the sign-in before a password', () => {
    const both = routingLabels(
      {
        ...app,
        basicAuth: {
          users: [{ name: 'u', hash: '$2a$10$' + 'a'.repeat(53) }],
          openPaths: [],
        },
      },
      { ...ctx, sso },
    );
    expect(both['traefik.http.routers.site-websecure.middlewares']).toBe(
      'site-sso,site-auth',
    );
  });
});
