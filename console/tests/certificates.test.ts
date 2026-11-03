import { describe, expect, it } from 'vitest';
import {
  certificatePhase,
  certificatePollMs,
  describeCertificate,
  diagnosisPollMs,
  RETRY_SETTLE_MS,
  retryWaitLabel,
  type CertificateDiagnosis,
} from '@/lib/certificates';

describe('describeCertificate', () => {
  it('says nothing for a host without HTTPS', () => {
    expect(describeCertificate({ host: 'a.test', state: 'off' })).toBeNull();
  });

  it('reports a good certificate with who issued it and how long it has', () => {
    expect(
      describeCertificate({
        host: 'a.test',
        state: 'valid',
        issuer: "Let's Encrypt",
        daysLeft: 60,
      }),
    ).toEqual({
      tone: 'ok',
      text: "Certificate issued by Let's Encrypt, expires in 60 days",
    });
    expect(
      describeCertificate({ host: 'a.test', state: 'valid', daysLeft: 1 })
        ?.text,
    ).toMatch(/1 day$/);
  });

  it('warns about a late renewal, an expired certificate and one still being waited for', () => {
    expect(
      describeCertificate({ host: 'a', state: 'expiring', daysLeft: 5 })?.tone,
    ).toBe('warn');
    expect(describeCertificate({ host: 'a', state: 'expired' })?.tone).toBe(
      'bad',
    );
    expect(describeCertificate({ host: 'a', state: 'pending' })?.text).toMatch(
      /port 80/,
    );
    expect(describeCertificate({ host: 'a', state: 'unreachable' })?.tone).toBe(
      'muted',
    );
  });

  it('polls quickly only while a certificate is pending', () => {
    expect(certificatePollMs(['valid', 'pending'])).toBe(10_000);
    expect(certificatePollMs(['valid', 'off'])).toBe(300_000);
  });
});

const diagnosis = (
  verdict: CertificateDiagnosis['verdict'],
  extra: Partial<CertificateDiagnosis> = {},
): CertificateDiagnosis => ({
  host: 'a.test',
  verdict,
  reason: 'x',
  title: 't',
  message: 'm',
  acme: null,
  dns: null,
  state: 'pending',
  retryAfterSeconds: 0,
  canRetry: true,
  ...extra,
});

describe('certificatePhase', () => {
  const now = 1_000_000;
  it('is checking until the first answer, and issued as soon as it is', () => {
    expect(certificatePhase(undefined, null, now)).toBe('checking');
    expect(certificatePhase(diagnosis('issued'), null, now)).toBe('issued');
    // issued wins over a retry that was just made
    expect(certificatePhase(diagnosis('issued'), now - 1000, now)).toBe(
      'issued',
    );
  });
  it('reads a recent retry as retrying, and goes back to what is true when the wait is over', () => {
    expect(certificatePhase(diagnosis('failed'), now - 5_000, now)).toBe(
      'retrying',
    );
    expect(
      certificatePhase(diagnosis('failed'), now - RETRY_SETTLE_MS - 1, now),
    ).toBe('failed');
  });
  it('passes the other verdicts through', () => {
    for (const v of ['waiting', 'failed', 'warning', 'off'] as const)
      expect(certificatePhase(diagnosis(v), null, now)).toBe(v);
  });
});

describe('diagnosisPollMs', () => {
  it('stops once there is nothing more to learn', () => {
    expect(diagnosisPollMs('issued', 0)).toBe(false);
    expect(diagnosisPollMs('off', 0)).toBe(false);
  });
  it('looks quickly while a retry settles, steadily while waiting, slowly on a problem', () => {
    expect(diagnosisPollMs('retrying', 0)).toBe(3_000);
    expect(diagnosisPollMs('waiting', 0)).toBe(5_000);
    expect(diagnosisPollMs('checking', 0)).toBe(5_000);
    expect(diagnosisPollMs('failed', 0)).toBe(15_000);
  });
  it('gives up after a person has watched for a quarter of an hour', () => {
    expect(diagnosisPollMs('failed', 15 * 60_000 + 1)).toBe(false);
    expect(diagnosisPollMs('waiting', 15 * 60_000 + 1)).toBe(false);
  });
});

describe('retryWaitLabel', () => {
  it('counts down, and is null when a retry may be made', () => {
    expect(retryWaitLabel(0)).toBeNull();
    expect(retryWaitLabel(45)).toBe('Retry in 45 s');
    expect(retryWaitLabel(150)).toBe('Retry in 3 min');
  });
});
