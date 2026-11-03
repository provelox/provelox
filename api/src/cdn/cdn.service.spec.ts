import { once } from 'node:events';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { makeStack } from '../test-utils';

const AWS = JSON.stringify({
  prefixes: [
    { ip_prefix: '10.0.0.0/24', service: 'CLOUDFRONT_ORIGIN_FACING' },
    { ip_prefix: '10.0.1.0/24', service: 'CLOUDFRONT_ORIGIN_FACING' },
    { ip_prefix: '10.9.0.0/24', service: 'CLOUDFRONT' },
    { ip_prefix: '10.8.0.0/24', service: 'EC2' },
  ],
  ipv6_prefixes: [
    { ipv6_prefix: '2600:9000::/32', service: 'CLOUDFRONT_ORIGIN_FACING' },
  ],
});

const setup = (body = AWS) => {
  const s = makeStack();
  const calls: string[] = [];
  s.cdn.fetchText = async (u) => {
    calls.push(u);
    return body;
  };
  return { ...s, calls };
};

describe('CdnService', () => {
  it("takes only CloudFront's origin-facing ranges", async () => {
    const { cdn } = setup();
    await cdn.ensureRanges('cloudfront');
    expect(cdn.ranges('cloudfront')).toEqual([
      '10.0.0.0/24',
      '10.0.1.0/24',
      '2600:9000::/32',
    ]);
  });

  it('does not fetch what it already has', async () => {
    const { cdn, calls } = setup();
    await cdn.ensureRanges('cloudfront');
    await cdn.ensureRanges('cloudfront');
    expect(calls).toHaveLength(1);
  });

  it('refuses an unknown CDN, and one whose ranges cannot be had', async () => {
    const { cdn } = setup();
    await expect(cdn.ensureRanges('nope')).rejects.toThrow(/no CDN called/);
    cdn.fetchText = async () => {
      throw new Error('down');
    };
    await expect(cdn.ensureRanges('cloudflare')).rejects.toThrow(
      /Could not get Cloudflare.*down/,
    );
  });

  it('trusts the ranges of the CDNs apps use, plus the manual setting', async () => {
    const { cdn, apps, cfg } = setup();
    cfg.PROXY_TRUSTED_IPS.push('192.0.2.0/24');
    await apps.create({ name: 'site' });
    expect(cdn.trustedIPs()).toEqual(['192.0.2.0/24']);
    await apps.update('site', {
      cdn: { provider: 'cloudfront', enforce: false },
    });
    expect(cdn.trustedIPs()).toEqual([
      '192.0.2.0/24',
      '10.0.0.0/24',
      '10.0.1.0/24',
      '2600:9000::/32',
    ]);
    await apps.update('site', { cdn: null });
    expect(cdn.trustedIPs()).toEqual(['192.0.2.0/24']);
  });

  it('keeps the saved ranges when a refresh fails or comes back broken', async () => {
    const { cdn, apps } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      cdn: { provider: 'cloudfront', enforce: true },
    });
    const before = cdn.ranges('cloudfront');
    cdn.fetchText = async () => {
      throw new Error('503');
    };
    expect((await cdn.refreshAll()).failed).toEqual([
      { id: 'cloudfront', error: '503' },
    ]);
    cdn.fetchText = async () =>
      JSON.stringify({ prefixes: [], ipv6_prefixes: [] });
    await cdn.refreshAll();
    expect(cdn.ranges('cloudfront')).toEqual(before);
    expect(cdn.view().find((v) => v.id === 'cloudfront')?.error).toMatch(
      /empty/,
    );
  });

  it('refuses a list that shrinks to under half', async () => {
    const many = (n: number) =>
      JSON.stringify({
        prefixes: Array.from({ length: n }, (_, i) => ({
          ip_prefix: `10.0.${i}.0/24`,
          service: 'CLOUDFRONT_ORIGIN_FACING',
        })),
      });
    const { cdn, apps } = setup(many(10));
    await apps.create({ name: 'site' });
    await apps.update('site', {
      cdn: { provider: 'cloudfront', enforce: false },
    });
    cdn.fetchText = async () => many(3);
    await cdn.refreshAll();
    expect(cdn.ranges('cloudfront')).toHaveLength(10);
    cdn.fetchText = async () => many(8);
    expect((await cdn.refreshAll()).changed).toEqual(['cloudfront']);
    expect(cdn.ranges('cloudfront')).toHaveLength(8);
  });

  it('puts the new ranges into the routing of apps that enforce their CDN', async () => {
    const { cdn, apps, docker } = setup();
    apps.onApplicationBootstrap();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      cdn: { provider: 'cloudfront', enforce: true },
    });
    const labels = () => docker.services.get('pvx-site')?.Labels ?? {};
    expect(
      labels()['traefik.http.middlewares.site-cdn.ipallowlist.sourcerange'],
    ).toBe('10.0.0.0/24,10.0.1.0/24,2600:9000::/32');
    cdn.fetchText = async () =>
      JSON.stringify({
        prefixes: [
          { ip_prefix: '10.5.5.0/24', service: 'CLOUDFRONT_ORIGIN_FACING' },
        ],
      });
    // a drop from 3 ranges to 1 is under half but below the size where that is judged
    await cdn.refreshAll();
    expect(
      labels()['traefik.http.middlewares.site-cdn.ipallowlist.sourcerange'],
    ).toBe('10.5.5.0/24');
  });

  it('does not enforce when the app only declares its CDN', async () => {
    const { apps, docker } = setup();
    await apps.create({ name: 'site' });
    await apps.update('site', {
      cdn: { provider: 'cloudfront', enforce: false },
    });
    expect(
      JSON.stringify(docker.services.get('pvx-site')?.Labels),
    ).not.toContain('ipallowlist');
  });

  it('refuses to set a CDN whose ranges cannot be fetched, leaving the app as it was', async () => {
    const { apps, cdn, repo } = setup();
    await apps.create({ name: 'site' });
    cdn.fetchText = async () => {
      throw new Error('offline');
    };
    await expect(
      apps.update('site', { cdn: { provider: 'cloudfront', enforce: true } }),
    ).rejects.toThrow(/Could not get/);
    expect(repo.get('site')?.cdn).toBeUndefined();
  });

  it('says why a fetch failed, not just that it did', async () => {
    const s = makeStack();
    // the real fetch, against a port that was open a moment ago
    const srv = createServer().listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const { port } = srv.address() as AddressInfo;
    await new Promise((r) => srv.close(r));
    const err = await s.cdn
      .saveCustom('gone', {
        label: 'Gone',
        url: `http://127.0.0.1:${port}/ips.txt`,
      })
      .catch((e: Error) => e.message);
    expect(err).toMatch(/could not reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
  });

  it("reads a list of a few MB (AWS's is 3 MB) but not one that never ends", async () => {
    const s = makeStack();
    const line = '198.51.100.0/24\n';
    const srv = createHttp((req, res) => {
      const mb = req.url === '/big' ? 17 : 3;
      res.write(line.repeat(Math.floor((mb * 1024 * 1024) / line.length)));
      res.end();
    }).listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const { port } = srv.address() as AddressInfo;
    try {
      const ok = await s.cdn.saveCustom('big-ok', {
        label: 'Big',
        url: `http://127.0.0.1:${port}/ok`,
      });
      expect(ok.ranges).toBe(1);
      await expect(
        s.cdn.saveCustom('too-big', {
          label: 'Too big',
          url: `http://127.0.0.1:${port}/big`,
        }),
      ).rejects.toThrow(/too large/);
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  describe('custom CDNs', () => {
    it('saves one with fixed ranges and uses it like a built-in', async () => {
      const { cdn, apps } = setup();
      await cdn.saveCustom('acme', {
        label: 'Acme CDN',
        clientIpHeader: 'True-Client-IP',
        cidrs: ['198.51.100.0/24', '203.0.113.9'],
      });
      expect(cdn.ranges('acme')).toEqual(['198.51.100.0/24', '203.0.113.9/32']);
      await apps.create({ name: 'site' });
      await apps.update('site', { cdn: { provider: 'acme', enforce: true } });
      expect(cdn.trustedIPs()).toEqual(['198.51.100.0/24', '203.0.113.9/32']);
    });

    it('fetches ranges from an address, and does not save one it cannot fetch', async () => {
      const { cdn } = setup('198.51.100.0/24\n203.0.113.0/24\n');
      const v = await cdn.saveCustom('acme', {
        label: 'Acme',
        url: 'https://acme.example/ips.txt',
      });
      expect(v.ranges).toBe(2);
      cdn.fetchText = async () => '<html>';
      await expect(
        cdn.saveCustom('bad', { label: 'Bad', url: 'https://bad.example/x' }),
      ).rejects.toThrow(/Could not get/);
      expect(cdn.provider('bad')).toBeUndefined();
    });

    it('validates what it is given', async () => {
      const { cdn } = setup();
      await expect(
        cdn.saveCustom('cloudfront', { label: 'x', cidrs: ['1.1.1.0/24'] }),
      ).rejects.toThrow(/built in/);
      await expect(
        cdn.saveCustom('acme', { label: 'x', cidrs: ['nope'] }),
      ).rejects.toThrow(/not an IP range/);
      await expect(cdn.saveCustom('acme', { label: 'x' })).rejects.toThrow(
        /either an address/,
      );
      await expect(
        cdn.saveCustom('Bad Id', { label: 'x', cidrs: ['1.1.1.0/24'] }),
      ).rejects.toThrow(/lowercase/);
    });

    it('cannot be removed while an app sits behind it', async () => {
      const { cdn, apps } = setup();
      await cdn.saveCustom('acme', {
        label: 'Acme',
        cidrs: ['198.51.100.0/24'],
      });
      await apps.create({ name: 'site' });
      await apps.update('site', { cdn: { provider: 'acme', enforce: false } });
      await expect(cdn.removeCustom('acme')).rejects.toThrow(
        /site is set to sit behind/,
      );
      await apps.update('site', { cdn: null });
      await cdn.removeCustom('acme');
      expect(cdn.provider('acme')).toBeUndefined();
    });
  });
});
