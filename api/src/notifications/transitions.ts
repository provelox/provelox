import type { CertificateInfo } from '../proxy/certificates';

/** How an app is doing, for deciding whether to say something. */
export type AppCondition =
  | 'ok'
  | 'failed'
  | 'unhealthy'
  /** Stopped on purpose */
  | 'stopped'
  /** Still starting: not good, not bad yet */
  | 'pending';

export function conditionOf(view: {
  app: { instanceCount: number };
  status: { state: string; health?: string } | null;
}): AppCondition {
  if (view.app.instanceCount === 0) return 'stopped';
  const s = view.status;
  // Docker has no service for an app that should run: that is a failure, not a quiet app
  if (!s || s.state === 'failed') return 'failed';
  if (s.state === 'stopped') return 'stopped';
  if (s.state === 'starting') return 'pending';
  if (s.health === 'unhealthy') return 'unhealthy';
  if (s.health === 'starting') return 'pending';
  return 'ok';
}

export interface Tracker {
  /** Checks in a row that found it bad */
  bad: number;
  /** A problem has been reported and not yet followed by a recovery */
  alerted: boolean;
}

export type ProblemEvent =
  | { type: 'problem'; app: string; problem: 'failed' | 'unhealthy' }
  | { type: 'recovered'; app: string };

/** How many checks in a row must find an app bad before it is reported: a restart blips for a moment and is not news. */
export const CONFIRM_CHECKS = 2;

/**
 * One check of one app. Reports a problem once it has lasted, and a recovery once it ends; says nothing while an app
 * stays bad, stops on purpose, or is merely starting.
 */
export function step(
  app: string,
  prev: Tracker | undefined,
  now: AppCondition,
  confirm = CONFIRM_CHECKS,
): { next: Tracker; event?: ProblemEvent } {
  const t = prev ?? { bad: 0, alerted: false };
  if (now === 'failed' || now === 'unhealthy') {
    const bad = t.bad + 1;
    if (bad >= confirm && !t.alerted)
      return {
        next: { bad, alerted: true },
        event: { type: 'problem', app, problem: now },
      };
    return { next: { bad, alerted: t.alerted } };
  }
  if (now === 'ok')
    return {
      next: { bad: 0, alerted: false },
      event: t.alerted ? { type: 'recovered', app } : undefined,
    };
  // stopped or still starting: not a verdict either way
  return { next: { bad: 0, alerted: false } };
}

export type CertLevel = 'ok' | 'expiring' | 'expired';
export type CertEvent = {
  type: 'certificate';
  host: string;
  level: 'expiring' | 'expired';
  daysLeft?: number;
};

/**
 * One check of one certificate. Says something when it starts to run out (once) and when it has run out (once), and
 * forgets that when it is renewed. A host that could not be checked keeps its last level.
 */
export function certificateStep(
  prev: CertLevel | undefined,
  c: CertificateInfo,
): { level: CertLevel | undefined; event?: CertEvent } {
  const level: CertLevel | undefined =
    c.state === 'valid'
      ? 'ok'
      : c.state === 'expiring'
        ? 'expiring'
        : c.state === 'expired'
          ? 'expired'
          : prev;
  if (level === 'ok' || level === undefined || level === prev) return { level };
  return {
    level,
    event: { type: 'certificate', host: c.host, level, daysLeft: c.daysLeft },
  };
}

export interface Message {
  title: string;
  text: string;
}

export function messageFor(e: ProblemEvent | CertEvent): Message {
  if (e.type === 'recovered')
    return {
      title: `${e.app} is back`,
      text: `${e.app} is running normally again.`,
    };
  if (e.type === 'problem')
    return e.problem === 'unhealthy'
      ? {
          title: `${e.app} is unhealthy`,
          text: `${e.app} is running, but its health check is failing.`,
        }
      : {
          title: `${e.app} is failing`,
          text: `${e.app} keeps failing to start or has no running instance.`,
        };
  return e.level === 'expired'
    ? {
        title: `Certificate for ${e.host} has expired`,
        text: `Visitors to ${e.host} see a security warning. Check that port 80 is reachable and the domain points here.`,
      }
    : {
        title: `Certificate for ${e.host} expires soon`,
        text: `It expires in ${e.daysLeft ?? 'a few'} day${e.daysLeft === 1 ? '' : 's'} and has not renewed. Check that port 80 is reachable.`,
      };
}
