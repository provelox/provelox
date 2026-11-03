import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerCertificate } from 'node:tls';
import {
  certificateStatus,
  describeCertificate,
  proxyProbe,
} from './certificates';

const NOW = Date.UTC(2026, 9, 15);
const day = (n: number) => new Date(NOW + n * 86_400_000).toUTCString();
const cert = (over: Partial<PeerCertificate>): PeerCertificate =>
  ({
    subject: { CN: 'app.example.com' },
    issuer: { O: "Let's Encrypt" },
    subjectaltname: 'DNS:app.example.com',
    valid_to: day(60),
    ...over,
  }) as unknown as PeerCertificate;

describe('describeCertificate', () => {
  it('is valid when the certificate covers the host and is in date', () => {
    const r = describeCertificate('app.example.com', cert({}), NOW);
    expect(r).toMatchObject({
      state: 'valid',
      issuer: "Let's Encrypt",
      daysLeft: 60,
    });
    expect(r.expiresAt).toBe(new Date(NOW + 60 * 86_400_000).toISOString());
  });

  it('warns when it ends within two weeks, and says so when it has ended', () => {
    expect(
      describeCertificate('app.example.com', cert({ valid_to: day(9) }), NOW)
        .state,
    ).toBe('expiring');
    expect(
      describeCertificate('app.example.com', cert({ valid_to: day(-2) }), NOW)
        .state,
    ).toBe('expired');
  });

  it('treats the proxy’s own placeholder, or a certificate for another name, as no certificate yet', () => {
    expect(
      describeCertificate(
        'app.example.com',
        cert({
          subject: { CN: 'TRAEFIK DEFAULT CERT' } as never,
          subjectaltname: '',
        }),
        NOW,
      ).state,
    ).toBe('pending');
    expect(describeCertificate('other.example.com', cert({}), NOW).state).toBe(
      'pending',
    );
  });

  it('accepts a wildcard for one label only', () => {
    const wild = cert({
      subjectaltname: 'DNS:*.example.com',
      subject: { CN: '*.example.com' } as never,
    });
    expect(describeCertificate('a.example.com', wild, NOW).state).toBe('valid');
    expect(describeCertificate('a.b.example.com', wild, NOW).state).toBe(
      'pending',
    );
  });

  it('is unreachable when nothing answered', () => {
    expect(describeCertificate('app.example.com', null, NOW).state).toBe(
      'unreachable',
    );
  });
});

describe('certificateStatus', () => {
  it('only asks about hosts that serve HTTPS', async () => {
    const asked: string[] = [];
    const r = await certificateStatus(
      [
        { host: 'a.example.com', ssl: true },
        { host: 'b.example.com', ssl: false },
      ],
      async (h) => {
        asked.push(h);
        return cert({
          subject: { CN: h } as never,
          subjectaltname: `DNS:${h}`,
        });
      },
      NOW,
    );
    expect(asked).toEqual(['a.example.com']);
    expect(r.map((x) => x.state)).toEqual(['valid', 'off']);
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

(hasOpenssl ? describe : describe.skip)(
  'proxyProbe against a real TLS server',
  () => {
    let dir: string;
    let server: Server;
    let port: number;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'pvx-cert-'));
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(dir, 'k.pem'),
          '-out',
          join(dir, 'c.pem'),
          '-days',
          '30',
          '-subj',
          '/CN=probe.example.com/O=Test CA',
          '-addext',
          'subjectAltName=DNS:probe.example.com',
        ],
        { stdio: 'ignore' },
      );
      server = createServer({
        key: readFileSync(join(dir, 'k.pem')),
        cert: readFileSync(join(dir, 'c.pem')),
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads the certificate the server presents', async () => {
      const r = await certificateStatus(
        [{ host: 'probe.example.com', ssl: true }],
        proxyProbe('127.0.0.1', port),
      );
      expect(r[0].state).toBe('valid');
      expect(r[0].issuer).toBe('Test CA');
      expect(r[0].daysLeft).toBeGreaterThanOrEqual(29);
    });

    it('says unreachable when nothing listens', async () => {
      const r = await certificateStatus(
        [{ host: 'probe.example.com', ssl: true }],
        proxyProbe('127.0.0.1', 1, 500),
      );
      expect(r[0].state).toBe('unreachable');
    });
  },
);
