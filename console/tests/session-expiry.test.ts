/**
 * Regression: after CapRover restarts (or the password changes) every login token dies while the console's
 * cookie is still valid. /login then redirected to /apps and /apps back to /login forever, freezing the tab.
 * Expired tokens must go through a route that clears the cookie.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: null as null | { token: string; exp: number },
  destroyed: 0,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    // like Next's own redirect(): the digest is how callers recognise it as control flow
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      to,
      digest: `NEXT_REDIRECT;replace;${to};307;`,
    });
  },
}));
vi.mock('@/lib/session', () => ({
  getSession: async () => state.session,
  destroySession: async () => {
    state.destroyed++;
  },
}));

import { GET as expired } from '@/app/api/session/expired/route';
import { BackendError } from '@/lib/backend';
import {
  SESSION_EXPIRED_PATH,
  withSession,
  withSessionOr,
} from '@/lib/with-session';

const redirectedTo = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { to?: string }).to;
  }
  return undefined;
};

beforeEach(() => {
  state.session = { token: 'tok', exp: Date.now() + 1000 };
  state.destroyed = 0;
});

describe('withSession', () => {
  it('returns the result and passes the token', async () => {
    expect(await withSession(async (t) => `ok:${t}`)).toBe('ok:tok');
  });

  it('sends a signed-out visitor to the login page', async () => {
    state.session = null;
    expect(await redirectedTo(withSession(async () => 1))).toBe('/login');
  });

  it('sends a rejected token (HTTP 401) through the route that clears the cookie, not straight to /login', async () => {
    const to = await redirectedTo(
      withSession(async () => {
        throw new BackendError(
          401,
          'Session expired, sign in again',
          'unauthorized',
        );
      }),
    );
    expect(to).toBe(SESSION_EXPIRED_PATH);
    expect(to).not.toBe('/login');
  });

  it('does not treat a rate-limit answer as an expired session', async () => {
    await expect(
      withSession(async () => {
        throw new BackendError(401, 'Too many wrong passwords', 'rate_limited');
      }),
    ).rejects.toThrow('Too many');
  });

  it('lets other failures through untouched', async () => {
    await expect(
      withSession(async () => {
        throw new BackendError(0, 'Cannot reach the Provelox API');
      }),
    ).rejects.toThrow('Cannot reach');
    await expect(
      withSession(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withSessionOr', () => {
  it('gives the fallback when an optional extra fails', async () => {
    const r = await withSessionOr(async () => {
      throw new BackendError(0, 'down');
    }, 'fallback');
    expect(r).toBe('fallback');
  });

  it('still signs out an expired session instead of hiding it behind the fallback', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/api/session/expired;307;',
    });
    await expect(
      withSessionOr(async () => {
        throw redirect;
      }, 'fallback'),
    ).rejects.toBe(redirect);
    // and the 401 path itself (withSession redirects), not the fallback
    const to = await redirectedTo(
      withSessionOr(async () => {
        throw new BackendError(401, 'expired', 'unauthorized');
      }, 'fallback'),
    );
    expect(to).toBe(SESSION_EXPIRED_PATH);
  });

  it('returns the value when all is well', async () => {
    expect(await withSessionOr(async (t) => `ok:${t}`, 'x')).toBe('ok:tok');
  });
});

describe('/api/session/expired', () => {
  it('clears the cookie and lands on the login page', async () => {
    const res = await expired(
      new Request('http://localhost:4300/api/session/expired'),
    );
    expect(state.destroyed).toBe(1);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });
});
