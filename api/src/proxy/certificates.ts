import { connect, type PeerCertificate } from 'node:tls';

export type CertificateState =
  /** A certificate for this host is served and in date */
  | 'valid'
  /** In date, but ends within two weeks: renewal should have happened by now */
  | 'expiring'
  | 'expired'
  /** The proxy answers with its own placeholder certificate: it has none for this host (yet) */
  | 'pending'
  /** HTTPS is not turned on for this host */
  | 'off'
  /** The proxy could not be reached to ask */
  | 'unreachable';

export interface CertificateInfo {
  host: string;
  state: CertificateState;
  issuer?: string;
  expiresAt?: string;
  daysLeft?: number;
}

const DAY = 86_400_000;
const EXPIRING_DAYS = 14;

/** Whether a certificate's names cover a host, wildcards included. */
function covers(cert: PeerCertificate, host: string): boolean {
  const names = (cert.subjectaltname ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.startsWith('DNS:'))
    .map((n) => n.slice(4).toLowerCase());
  if (cert.subject?.CN) names.push(String(cert.subject.CN).toLowerCase());
  return names.some(
    (n) =>
      n === host ||
      (n.startsWith('*.') &&
        host.endsWith(n.slice(1)) &&
        !host.slice(0, -n.length + 1).includes('.')),
  );
}

const issuerName = (cert: PeerCertificate) =>
  String(cert.issuer?.O ?? cert.issuer?.CN ?? '') || undefined;

/** What a served certificate says about a host. Pure, so every case can be tested without a network. */
export function describeCertificate(
  host: string,
  cert: PeerCertificate | null,
  now = Date.now(),
): CertificateInfo {
  if (!cert || !cert.valid_to) return { host, state: 'unreachable' };
  const issuer = issuerName(cert);
  // Traefik answers with its self-signed default while it has no certificate for the name
  const isDefault =
    /traefik default cert/i.test(String(cert.subject?.CN ?? '')) ||
    !covers(cert, host);
  if (isDefault) return { host, state: 'pending', issuer };
  const end = new Date(cert.valid_to).getTime();
  const daysLeft = Math.floor((end - now) / DAY);
  return {
    host,
    state:
      end < now ? 'expired' : daysLeft < EXPIRING_DAYS ? 'expiring' : 'valid',
    issuer,
    expiresAt: new Date(end).toISOString(),
    daysLeft,
  };
}

/** Asks the proxy which certificate it serves for a host name, or null if it cannot be reached. */
export type TlsProbe = (host: string) => Promise<PeerCertificate | null>;

/** Connects to the proxy as a browser would (the host name as SNI) and reads the certificate it presents. */
export function proxyProbe(
  address: string,
  port: number,
  timeoutMs = 4000,
): TlsProbe {
  return (host) =>
    new Promise((resolve) => {
      const socket = connect({
        host: address,
        port,
        servername: host,
        // The point is to read whatever is served, including the proxy's placeholder
        rejectUnauthorized: false,
      });
      const done = (cert: PeerCertificate | null) => {
        socket.destroy();
        resolve(cert);
      };
      socket.setTimeout(timeoutMs, () => done(null));
      socket.once('error', () => done(null));
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        done(cert && Object.keys(cert).length ? cert : null);
      });
    });
}

export async function certificateStatus(
  hosts: { host: string; ssl: boolean }[],
  probe: TlsProbe,
  now = Date.now(),
): Promise<CertificateInfo[]> {
  return Promise.all(
    hosts.map(async (h) =>
      h.ssl
        ? describeCertificate(h.host, await probe(h.host), now)
        : { host: h.host, state: 'off' as const },
    ),
  );
}
