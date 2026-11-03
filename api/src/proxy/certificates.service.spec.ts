import 'reflect-metadata';
import { TOKEN_SCOPE } from '../auth/scope.decorator';
import {
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';
import { CertificatesController } from './certificates.controller';
import {
  CertificatesService,
  RETRIES_PER_HOUR,
  RETRY_COOLDOWN_SECONDS,
  retryLabel,
} from './certificates.service';
import type { PeerCertificate } from 'node:tls';

const T0 = 1_800_000_000_000;

async function setup(env: Record<string, string> = {}) {
  const stack = makeStack(env);
  const svc = new CertificatesService(
    stack.apps,
    stack.settings,
    stack.docker,
    stack.cfg,
  );
  const table: Record<string, string[]> = {
    'site.example.com': ['1.2.3.4'],
    'shop.example.org': ['1.2.3.4'],
  };
  svc.resolver = async (h) => table[h] ?? [];
  await stack.apps.create({ name: 'site' });
  await stack.apps.update('site', {
    domains: [{ host: 'shop.example.org', ssl: true }],
  });
  // no certificate for it: the proxy shows its own placeholder
  stack.apps.tlsProbe = async () =>
    ({
      valid_to: 'x',
      subject: { CN: 'TRAEFIK DEFAULT CERT' },
    }) as unknown as PeerCertificate;
  return { ...stack, svc, table };
}

describe('CertificatesService.retry', () => {
  it('changes a label Traefik reads on the app service, and nothing else', async () => {
    const { svc, docker } = await setup();
    const before = structuredClone(docker.services.get('pvx-site')!);
    await svc.retry('site', 'shop.example.org', T0);
    const after = docker.services.get('pvx-site')!;
    const key = retryLabel('site');
    expect(after.Labels[key]).toMatch(/^1\d\dms$/);
    expect(after.Labels[key]).not.toBe('100ms');
    expect({ ...after.Labels, [key]: undefined }).toEqual({
      ...before.Labels,
      [key]: undefined,
    });
    expect(after.TaskTemplate).toEqual(before.TaskTemplate); // no restart
    expect(docker.calls).toContain('edit:pvx-site');
  });

  it('picks a different value each time, so Traefik always sees a change', async () => {
    const { svc, docker } = await setup();
    const seen: string[] = [];
    for (let i = 0; i < RETRIES_PER_HOUR; i++) {
      await svc.retry(
        'site',
        'shop.example.org',
        T0 + i * 2 * RETRY_COOLDOWN_SECONDS * 1000,
      );
      seen.push(docker.services.get('pvx-site')!.Labels[retryLabel('site')]);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('waits a minute between tries, and allows three an hour', async () => {
    const { svc } = await setup();
    await svc.retry('site', 'shop.example.org', T0);
    const soon = svc.retry('site', 'shop.example.org', T0 + 30_000);
    await expect(soon).rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(soon).rejects.toThrow(/30 seconds/);
    const step = (RETRY_COOLDOWN_SECONDS + 1) * 1000;
    await svc.retry('site', 'shop.example.org', T0 + step);
    await svc.retry('site', 'shop.example.org', T0 + 2 * step);
    const capped = svc.retry('site', 'shop.example.org', T0 + 3 * step);
    await expect(capped).rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(capped).rejects.toThrow(/few failed attempts per hour/);
    // the hour passes
    await expect(
      svc.retry('site', 'shop.example.org', T0 + 3_600_001),
    ).resolves.toMatchObject({ retried: true });
  });

  it('refuses addresses the app does not serve, HTTPS that is off, and a missing email', async () => {
    const { svc, settings } = await setup();
    await expect(
      svc.retry('site', 'other.example.net', T0),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      svc.retry('nope', 'shop.example.org', T0),
    ).rejects.toBeInstanceOf(NotFoundError);
    // site.example.com has HTTPS off
    await expect(
      svc.retry('site', 'site.example.com', T0),
    ).rejects.toBeInstanceOf(ValidationError);
    // the email is cleared after HTTPS was turned on
    settings.set('acmeEmail', '');
    await expect(svc.retry('site', 'shop.example.org', T0)).rejects.toThrow(
      /email/i,
    );
  });

  it('refuses when this install runs no proxy', async () => {
    const stack = await setup({ PROXY_ENABLED: 'false' });
    await expect(
      stack.svc.retry('site', 'shop.example.org', T0),
    ).rejects.toThrow(/proxy/i);
  });

  it('says so when the app has no service to change', async () => {
    const { svc, docker } = await setup();
    docker.services.delete('pvx-site');
    await expect(
      svc.retry('site', 'shop.example.org', T0),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CertificatesService.diagnosis', () => {
  it('starts waiting, calls it stuck after the grace period, and starts again after a retry', async () => {
    const { svc } = await setup();
    const first = await svc.diagnosis('site', 'shop.example.org', T0);
    expect(first).toMatchObject({
      verdict: 'waiting',
      state: 'pending',
      canRetry: true,
      retryAfterSeconds: 0,
    });
    expect(first.dns?.state).toBe('match');
    const later = await svc.diagnosis('site', 'shop.example.org', T0 + 200_000);
    expect(later).toMatchObject({ verdict: 'failed', reason: 'stuck' });
    await svc.retry('site', 'shop.example.org', T0 + 210_000);
    const again = await svc.diagnosis('site', 'shop.example.org', T0 + 215_000);
    expect(again).toMatchObject({ verdict: 'waiting' });
    expect(again.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reads the DNS problems', async () => {
    const { svc, table } = await setup();
    delete table['shop.example.org'];
    expect(await svc.diagnosis('site', 'shop.example.org', T0)).toMatchObject({
      reason: 'dns-none',
    });
    table['shop.example.org'] = ['9.9.9.9'];
    expect(await svc.diagnosis('site', 'shop.example.org', T0)).toMatchObject({
      reason: 'dns-elsewhere',
    });
  });

  it('quotes the real error from the proxy log, only for this host', async () => {
    const { svc, docker } = await setup();
    const err = (host: string, text: string) => ({
      ts: '',
      stream: 'stderr' as const,
      text: `ERR Unable to obtain ACME certificate for domains error="${text}" domains=["${host}"]`,
    });
    docker.logs.set('pvx-traefik', [
      err(
        'shop.example.org',
        'acme: error: 400 :: urn:ietf:params:acme:error:connection :: Timeout during connect',
      ),
      err('another.example.org', 'unrelated'),
    ]);
    const r = await svc.diagnosis('site', 'shop.example.org', T0);
    expect(r).toMatchObject({ verdict: 'failed', reason: 'acme-error' });
    expect(r.acme?.raw).toContain('Timeout during connect');
    expect(r.acme?.raw).not.toContain('unrelated');
  });

  it('has nothing to retry for an issued certificate or HTTPS that is off', async () => {
    const { svc, apps } = await setup();
    expect(await svc.diagnosis('site', 'site.example.com', T0)).toMatchObject({
      verdict: 'off',
      canRetry: false,
    });
    apps.tlsProbe = async () =>
      ({
        valid_to: new Date(T0 + 60 * 86_400_000).toISOString(),
        subject: { CN: 'shop.example.org' },
        subjectaltname: 'DNS:shop.example.org',
        issuer: { O: "Let's Encrypt" },
      }) as unknown as PeerCertificate;
    expect(await svc.diagnosis('site', 'shop.example.org', T0)).toMatchObject({
      verdict: 'issued',
      canRetry: false,
    });
  });

  it('404s for an address the app does not serve', async () => {
    const { svc } = await setup();
    await expect(
      svc.diagnosis('site', 'x.example.net', T0),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('who may call it', () => {
  const scopeOf = (method: keyof CertificatesController) =>
    Reflect.getMetadata(TOKEN_SCOPE, CertificatesController.prototype[method]);
  it('lets a read token ask why, and only the signed-in admin ask again', () => {
    expect(scopeOf('diagnosis')).toBe('read');
    // no scope at all: tokens cannot change what a domain does (the rule for every change to domains)
    expect(scopeOf('retry')).toBeUndefined();
  });
});
