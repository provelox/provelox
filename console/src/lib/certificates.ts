import type { CertificateStatus } from './backend';

export interface CertificateLine {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  text: string;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** One line about a certificate for the domains list, in plain words. Null when there is nothing to say (no HTTPS). */
export function describeCertificate(
  c: CertificateStatus,
): CertificateLine | null {
  const issuer = c.issuer ? ` by ${c.issuer}` : '';
  switch (c.state) {
    case 'off':
      return null;
    case 'valid':
      return {
        tone: 'ok',
        text: `Certificate issued${issuer}, expires in ${days(c.daysLeft ?? 0)}`,
      };
    case 'expiring':
      return {
        tone: 'warn',
        text: `Certificate expires in ${days(c.daysLeft ?? 0)}. It should have renewed: check that port 80 is reachable.`,
      };
    case 'expired':
      return {
        tone: 'bad',
        text: 'Certificate has expired. Visitors see a security warning.',
      };
    case 'pending':
      return {
        tone: 'warn',
        text: 'No certificate yet. It is issued once the domain points here and port 80 is reachable.',
      };
    case 'unreachable':
      return { tone: 'muted', text: 'Could not check the certificate' };
  }
}

/** While a certificate is still being waited for, ask again soon; otherwise only now and then. */
export const certificatePollMs = (states: CertificateStatus['state'][]) =>
  states.includes('pending') ? 10_000 : 5 * 60_000;

/** What `GET apps/:name/domains/:host/diagnosis` answers: whether an address has a certificate and, if not, why. */
export interface CertificateDiagnosis {
  host: string;
  verdict: 'issued' | 'warning' | 'off' | 'waiting' | 'failed';
  reason: string;
  /** A short heading */
  title: string;
  /** The explanation, in plain words */
  message: string;
  /** Let's Encrypt's own refusal, when the proxy's log had one for this address */
  acme: {
    kind: 'dns' | 'connection' | 'challenge' | 'rate-limit' | 'caa' | 'other';
    message: string;
    raw: string;
  } | null;
  dns: {
    state: 'match' | 'elsewhere' | 'none' | 'unknown';
    addresses: string[];
    expected: string[];
  } | null;
  state: string;
  /** Seconds until a retry is allowed; 0 when it is allowed now */
  retryAfterSeconds: number;
  canRetry: boolean;
}

export type CertificatePhase =
  'checking' | 'issued' | 'warning' | 'off' | 'waiting' | 'retrying' | 'failed';

/** After a retry the proxy needs a moment: it looks at the Swarm every 15 seconds, then asks Let's Encrypt. */
export const RETRY_SETTLE_MS = 75_000;

/** Where an address is in getting its certificate, as the panel shows it. A retry in the last moments reads as retrying. */
export function certificatePhase(
  d: CertificateDiagnosis | undefined,
  retriedAt: number | null,
  now: number,
): CertificatePhase {
  if (!d) return 'checking';
  if (d.verdict === 'issued') return 'issued';
  if (retriedAt !== null && now - retriedAt < RETRY_SETTLE_MS)
    return 'retrying';
  return d.verdict;
}

/**
 * How soon to look again, or false to stop. Quickly while a retry settles, steadily while waiting, slowly while there is a
 * problem someone may be fixing, and not at all once it is issued, off, or a person has been looking for a long time.
 */
export function diagnosisPollMs(
  phase: CertificatePhase,
  watchedMs: number,
): number | false {
  if (phase === 'issued' || phase === 'off') return false;
  if (watchedMs > 15 * 60_000) return false;
  if (phase === 'retrying') return 3_000;
  if (phase === 'waiting' || phase === 'checking') return 5_000;
  return 15_000;
}

/** "Retry in 45 s", "Retry in 3 min", or null when it may be done now. */
export function retryWaitLabel(seconds: number): string | null {
  if (seconds <= 0) return null;
  return seconds < 100
    ? `Retry in ${seconds} s`
    : `Retry in ${Math.ceil(seconds / 60)} min`;
}
