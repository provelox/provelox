import { describeRequest } from './activity.describe';

const d = (
  method: string,
  route: string,
  params: Record<string, string> = {},
  body: unknown = {},
) => describeRequest(method, route, params, body);

describe('describeRequest', () => {
  it('names what a deploy deployed, and what it was about', () => {
    expect(
      d(
        'POST',
        '/apps/:name/deploy',
        { name: 'api' },
        { image: 'acme/api:2.4' },
      ),
    ).toEqual({ action: 'app.deploy', target: 'api', summary: 'acme/api:2.4' });
  });

  it('says which variables changed by name and never shows a value', () => {
    const out = d(
      'PATCH',
      '/apps/:name',
      { name: 'api' },
      {
        env: [
          { key: 'DATABASE_URL', value: 'postgres://u:hunter2@db/x' },
          { key: 'API_KEY', value: 'sk_live_abc' },
        ],
      },
    )!;
    expect(out.action).toBe('app.env.update');
    expect(out.summary).toContain('DATABASE_URL');
    expect(out.summary).toContain('API_KEY');
    expect(JSON.stringify(out)).not.toMatch(/hunter2|sk_live|postgres:/);
  });

  it('lists domains and keeps password protection to user names', () => {
    const domains = d(
      'PATCH',
      '/apps/:name',
      { name: 'a' },
      {
        domains: [{ host: 'shop.example.com', ssl: true }],
      },
    )!;
    expect(domains.action).toBe('app.domains.update');
    expect(domains.summary).toContain('shop.example.com');
    const pw = d(
      'PATCH',
      '/apps/:name',
      { name: 'a' },
      {
        basicAuth: { users: [{ name: 'ana', password: 'correct-horse-9' }] },
      },
    )!;
    expect(pw.action).toBe('app.password.update');
    expect(pw.summary).toContain('ana');
    expect(JSON.stringify(pw)).not.toContain('correct-horse');
  });

  it('calls a change of several kinds an app update and lists them all', () => {
    const out = d(
      'PATCH',
      '/apps/:name',
      { name: 'a' },
      {
        env: [{ key: 'A', value: 'x' }],
        containerPort: 3000,
      },
    )!;
    expect(out.action).toBe('app.update');
    expect(out.summary).toMatch(/variables.*A/);
    expect(out.summary).toContain('container port: 3000');
  });

  it('names a secret and never what it holds', () => {
    const out = d(
      'PUT',
      '/apps/:name/secrets/:secret',
      { name: 'api', secret: 'db-password' },
      { value: 'p@ssw0rd-very-secret' },
    )!;
    expect(out).toEqual({
      action: 'secret.set',
      target: 'api',
      summary: 'db-password',
    });
  });

  it('keeps only the host of an address that may carry a token', () => {
    const out = d(
      'POST',
      '/system/notifications/webhooks',
      {},
      {
        url: 'https://hooks.example.com/services/T000/B000/SECRETTOKEN',
      },
    )!;
    expect(out.summary).toBe('hooks.example.com');
    expect(
      d(
        'POST',
        '/templates/sources',
        {},
        {
          url: 'https://example.com/index.yaml?token=abc',
        },
      )!.summary,
    ).toBe('example.com');
  });

  it('keeps a registry login to its host and account, and an email to its domain', () => {
    const reg = d(
      'POST',
      '/registries',
      {},
      {
        domain: 'ghcr.io',
        username: 'ana',
        password: 'ghp_realtoken',
      },
    )!;
    expect(JSON.stringify(reg)).not.toContain('ghp_');
    expect(reg.summary).toBe('ana');
    expect(
      d('PUT', '/system/acme-email', {}, { email: 'ops@example.com' })!.summary,
    ).toBe('account at example.com');
  });

  it('does not log a deploy key, an access token or what they were made for beyond their names', () => {
    const k = d('POST', '/ci-keys', {}, { app: 'api', name: 'GitHub' })!;
    expect(k).toMatchObject({
      action: 'ci-key.create',
      target: 'api',
      summary: 'GitHub',
    });
    const t = d(
      'POST',
      '/system/access-tokens',
      {},
      { name: 'hub', scope: 'operate' },
    )!;
    expect(t.summary).toBe('hub (operate)');
  });

  it('skips what only asks a question', () => {
    for (const [m, r] of [
      ['POST', '/auth/login'],
      ['POST', '/projects/preview'],
      ['POST', '/registries/check'],
      ['POST', '/system/image-updates/check'],
      ['POST', '/system/notifications/webhooks/:id/test'],
    ])
      expect(d(m, r)).toBeNull();
  });

  it('gives a route nobody named an action from its path and nothing from its body', () => {
    const out = d(
      'POST',
      '/widgets/:name/frobnicate',
      { name: 'w' },
      {
        secret: 'do-not-keep',
      },
    )!;
    expect(out.action).toBe('widgets.frobnicate');
    expect(out.target).toBe('w');
    expect(out.summary).toBe('');
  });

  it('bounds what it keeps', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      key: `VAR_${i}`,
      value: 'x',
    }));
    const out = d('PATCH', '/apps/:name', { name: 'a' }, { env: many })!;
    expect(out.summary.length).toBeLessThanOrEqual(400);
    expect(out.summary).toContain('and 92 more');
  });
});
