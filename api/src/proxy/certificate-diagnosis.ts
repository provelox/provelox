import { lookup } from 'node:dns/promises';
import type { CertificateState } from './certificates';

/**
 * Working out, in words, why an address has no certificate. Everything here is pure except the resolver, so each case can
 * be tested without a network. It only says what the platform can know; the real reason from Let's Encrypt is quoted
 * only when the proxy's own log has it.
 */

export type DnsState = 'match' | 'elsewhere' | 'none' | 'unknown';

export interface DnsResult {
  /**
   * match: the address resolves to where the app's default address does. elsewhere: it resolves, but to other addresses.
   * none: it does not resolve yet. unknown: the default address itself does not resolve, so there is nothing to compare.
   */
  state: DnsState;
  addresses: string[];
  expected: string[];
}

export type Resolver = (host: string) => Promise<string[]>;

/** Every address a name resolves to (A and AAAA, through CNAMEs), or none. */
export const systemResolver: Resolver = async (host) => {
  try {
    const found = await lookup(host, { all: true });
    return [...new Set(found.map((a) => a.address))].sort();
  } catch {
    return [];
  }
};

export async function checkDns(
  host: string,
  target: string | null,
  resolve: Resolver,
): Promise<DnsResult> {
  const [addresses, expected] = await Promise.all([
    resolve(host),
    target ? resolve(target) : Promise.resolve([] as string[]),
  ]);
  const state: DnsState =
    expected.length === 0
      ? 'unknown'
      : addresses.length === 0
        ? 'none'
        : addresses.some((a) => expected.includes(a))
          ? 'match'
          : 'elsewhere';
  return { state, addresses, expected };
}

export type AcmeKind =
  'dns' | 'connection' | 'challenge' | 'rate-limit' | 'caa' | 'other';

export interface AcmeProblem {
  kind: AcmeKind;
  /** What it means, in plain words */
  message: string;
  /** What the proxy logged, as it logged it (shortened) */
  raw: string;
}

const MARKER =
  /Unable to obtain ACME certificate|unable to generate a certificate|acme: error|error obtaining certificate|Cannot obtain certificates/i;

const clean = (s: string) =>
  s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();

/** The newest line of the proxy's log that is a failure to get a certificate for this host, as its own text. */
export function acmeErrorFor(host: string, lines: string[]): string | null {
  const h = host.toLowerCase();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.toLowerCase().includes(h) || !MARKER.test(line)) continue;
    // Traefik writes the reason as error="..."; keep that part when it is there
    const quoted = line.match(/error="((?:[^"\\]|\\.)*)"/);
    const text = clean(quoted ? quoted[1] : line);
    return text.length > 600 ? `${text.slice(0, 597)}...` : text;
  }
  return null;
}

/** What a Let's Encrypt error text means for the person adding the domain. */
export function explainAcmeError(host: string, raw: string): AcmeProblem {
  const t = raw;
  if (/rateLimited|too many (failed|certificates|new)|rate limit/i.test(t))
    return {
      kind: 'rate-limit',
      raw,
      message:
        "Let's Encrypt is limiting attempts for this name (it allows only a few failed ones per hour). Wait an hour, fix the cause, then retry once.",
    };
  if (/\bCAA\b/i.test(t))
    return {
      kind: 'caa',
      raw,
      message: `A CAA record on ${host} (or its parent) does not allow Let's Encrypt to issue. Add one that allows letsencrypt.org, or remove it.`,
    };
  if (
    /urn:ietf:params:acme:error:dns|NXDOMAIN|no valid (A|AAAA)|SERVFAIL|DNS problem/i.test(
      t,
    )
  )
    return {
      kind: 'dns',
      raw,
      message: `Let's Encrypt could not find ${host} in DNS (or found no address for it). Check the record you created, and give DNS time to spread.`,
    };
  if (
    /urn:ietf:params:acme:error:connection|Timeout|timed out|connection refused|no route to host|Connection reset|i\/o timeout/i.test(
      t,
    )
  )
    return {
      kind: 'connection',
      raw,
      message: `Let's Encrypt found ${host} but could not connect to port 80 on this server. Open port 80 in the firewall (and on any router or cloud security group in front of it) and make sure nothing else listens there.`,
    };
  if (/unauthorized|Invalid response|404|403|wrong status/i.test(t))
    return {
      kind: 'challenge',
      raw,
      message: `Let's Encrypt reached a server at ${host} but it was not this proxy answering the check. Something else (another web server, a CDN or a redirect) is answering on port 80.`,
    };
  return {
    kind: 'other',
    raw,
    message:
      "Let's Encrypt refused to issue the certificate. Its own words are shown below.",
  };
}

/** How long a certificate may stay pending, with DNS right, before it is called stuck. Issuing usually takes seconds. */
export const PENDING_GRACE_SECONDS = 180;

export type Verdict = 'issued' | 'warning' | 'off' | 'waiting' | 'failed';

export type Reason =
  | 'https-off'
  | 'issued'
  | 'expiring'
  | 'expired'
  | 'proxy-off'
  | 'proxy-unreachable'
  | 'no-email'
  | 'acme-error'
  | 'dns-none'
  | 'dns-elsewhere'
  | 'waiting'
  | 'stuck';

export interface Diagnosis {
  verdict: Verdict;
  reason: Reason;
  /** A short heading for the panel */
  title: string;
  /** The explanation, in plain words */
  message: string;
  acme: AcmeProblem | null;
}

export interface DiagnosisInput {
  host: string;
  ssl: boolean;
  state: CertificateState;
  proxyEnabled: boolean;
  acmeEmailSet: boolean;
  dns: DnsResult | null;
  /** Seconds this address has been seen without a certificate, counted from the last retry; null when not pending */
  pendingSeconds: number | null;
  acmeError: string | null;
}

export function diagnose(i: DiagnosisInput): Diagnosis {
  const done = (
    verdict: Verdict,
    reason: Reason,
    title: string,
    message: string,
    acme: AcmeProblem | null = null,
  ): Diagnosis => ({ verdict, reason, title, message, acme });

  if (!i.ssl)
    return done(
      'off',
      'https-off',
      'HTTPS is off',
      `${i.host} is served over plain HTTP. Turn on HTTPS to get a certificate.`,
    );
  switch (i.state) {
    case 'valid':
      return done(
        'issued',
        'issued',
        'Certificate issued',
        `${i.host} has a valid certificate.`,
      );
    case 'expiring':
      return done(
        'warning',
        'expiring',
        'Certificate is about to expire',
        'It should already have renewed. Check that port 80 is reachable from the internet and that the Let’s Encrypt email is still set.',
      );
    case 'expired':
      return done(
        'failed',
        'expired',
        'Certificate has expired',
        'Visitors see a security warning. Retry the certificate; if it fails again, the reason is shown here.',
      );
    case 'unreachable':
      return !i.proxyEnabled
        ? done(
            'failed',
            'proxy-off',
            'The built-in proxy is off',
            'This install does not run the proxy that issues certificates, so HTTPS is handled elsewhere.',
          )
        : done(
            'waiting',
            'proxy-unreachable',
            'Could not ask the proxy',
            'The proxy did not answer a check just now. If this lasts, check that the proxy service is running.',
          );
    case 'off':
      return done(
        'off',
        'https-off',
        'HTTPS is off',
        `${i.host} is served over plain HTTP.`,
      );
    case 'pending':
      break;
  }

  // From here the address is waiting for a certificate
  if (!i.proxyEnabled)
    return done(
      'failed',
      'proxy-off',
      'The built-in proxy is off',
      'This install does not run the proxy that issues certificates, so none can be issued here.',
    );
  if (!i.acmeEmailSet)
    return done(
      'failed',
      'no-email',
      'No Let’s Encrypt email',
      'Let’s Encrypt needs an email address before it will issue certificates. Set one under Settings, Domain & HTTPS, then retry.',
    );
  if (i.acmeError) {
    const acme = explainAcmeError(i.host, i.acmeError);
    return done(
      'failed',
      'acme-error',
      'Let’s Encrypt refused',
      acme.message,
      acme,
    );
  }
  if (i.dns?.state === 'none')
    return done(
      'failed',
      'dns-none',
      'DNS is not set up yet',
      `${i.host} does not resolve to anything yet. Create the record shown above; DNS changes can take a few minutes, sometimes hours. A certificate is issued only once it resolves here.`,
    );
  if (i.dns?.state === 'elsewhere')
    return done(
      'failed',
      'dns-elsewhere',
      'DNS points somewhere else',
      `${i.host} resolves to ${i.dns.addresses.join(', ')}, not to this server (${i.dns.expected.join(', ')}). Point it here. If it is behind a proxy such as Cloudflare on purpose, this can be fine: retry and see.`,
    );
  const seconds = i.pendingSeconds ?? 0;
  if (seconds < PENDING_GRACE_SECONDS)
    return done(
      'waiting',
      'waiting',
      'Waiting for the certificate',
      i.dns?.state === 'match'
        ? 'DNS points here. Let’s Encrypt is being asked; this usually takes under a minute.'
        : 'Let’s Encrypt is being asked; this usually takes under a minute. This server could not check DNS, so that is not confirmed.',
    );
  return done(
    'failed',
    'stuck',
    'Still no certificate',
    `${i.dns?.state === 'match' ? 'DNS points here' : 'DNS could not be checked from here'}, but after ${Math.round(seconds / 60)} minutes there is still no certificate. The usual causes: port 80 is not reachable from the internet (a firewall or cloud security group), something else answers on port 80, or Let’s Encrypt’s limit for failed attempts on this name was reached (a few per hour). Fix the likely one, then retry.`,
  );
}
