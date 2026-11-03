'use server';

import { lookup } from 'node:dns/promises';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import type { BackendAppView } from '@/lib/backend-types';
import { asUser, UserError, type ActionResult } from './guard';

const appName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(80, 'Domain is too long')
  .regex(
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Enter a domain such as app.example.com',
  );

function done(result: ActionResult) {
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

/** Reads the app's current domains, applies a change, and writes the whole list back. */
async function editDomains(
  token: string,
  name: string,
  change: (
    current: { host: string; ssl: boolean }[],
  ) => { host: string; ssl: boolean }[],
) {
  const base = `apps/${appName.parse(name)}`;
  const view = await api<BackendAppView>(base, { token });
  await api(base, {
    method: 'PATCH',
    token,
    body: { domains: change(view.app.domains) },
  });
}

/**
 * Attaches a domain. Point its DNS at this server first: the certificate (when HTTPS is turned on) is issued
 * only if the domain resolves here and is reachable on port 80.
 */
export async function addCustomDomainAction(
  name: string,
  customDomain: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      const host = domain.parse(customDomain);
      await editDomains(token, name, (cur) => {
        if (cur.some((d) => d.host === host))
          throw new UserError('That domain is already attached.');
        return [...cur, { host, ssl: false }];
      });
    }),
  );
}

export async function removeCustomDomainAction(
  name: string,
  customDomain: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      const host = domain.parse(customDomain);
      await editDomains(token, name, (cur) =>
        cur.filter((d) => d.host !== host),
      );
    }),
  );
}

/** Turns on HTTPS for a domain: a certificate is requested from Let's Encrypt (needs the account email first). */
export async function enableCustomDomainSslAction(
  name: string,
  customDomain: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      const host = domain.parse(customDomain);
      await editDomains(token, name, (cur) => {
        if (!cur.some((d) => d.host === host))
          throw new UserError('That domain is not attached to the app.');
        return cur.map((d) => (d.host === host ? { ...d, ssl: true } : d));
      });
    }),
  );
}

/**
 * Asks the proxy to try for an address's certificate again. The API refuses a retry made too soon (a minute) or too
 * often (three an hour), because each failed attempt counts against Let's Encrypt's limit; its message is shown as it is.
 */
export async function retryCertificateAction(
  name: string,
  customDomain: string,
): Promise<ActionResult<{ retryAfterSeconds: number }>> {
  return asUser(async (token) => {
    const host = domain.parse(customDomain);
    const res = await api<{ retryAfterSeconds: number }>(
      `apps/${appName.parse(name)}/domains/${encodeURIComponent(host)}/retry-certificate`,
      { method: 'POST', token },
    );
    revalidatePath('/apps/[name]', 'layout');
    return { retryAfterSeconds: res.retryAfterSeconds };
  });
}

export async function enableDefaultSubDomainSslAction(
  name: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api(`apps/${appName.parse(name)}`, {
        method: 'PATCH',
        token,
        body: { defaultSubdomainSsl: true },
      });
    }),
  );
}

export interface DnsCheck {
  /**
   * match: the domain resolves to where the app's default domain does.
   * elsewhere: it resolves, but to other addresses. none: it does not resolve yet.
   * unknown: the default domain itself does not resolve from here, so there is nothing to compare with.
   */
  state: 'match' | 'elsewhere' | 'none' | 'unknown';
  /** What the domain resolves to now */
  addresses: string[];
  /** What it should resolve to: the addresses of the app's default domain */
  expected: string[];
}

async function addressesOf(host: string): Promise<string[]> {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

/** Says whether a domain's DNS already points where the app's default domain does. Changes nothing. */
export async function checkDnsAction(
  customDomain: string,
  defaultDomain: string,
): Promise<ActionResult<DnsCheck>> {
  return asUser(async () => {
    const host = domain.parse(customDomain);
    const target = domain.parse(defaultDomain);
    const [addresses, expected] = await Promise.all([
      addressesOf(host),
      addressesOf(target),
    ]);
    const state: DnsCheck['state'] =
      expected.length === 0
        ? 'unknown'
        : addresses.length === 0
          ? 'none'
          : addresses.some((a) => expected.includes(a))
            ? 'match'
            : 'elsewhere';
    return { state, addresses, expected };
  });
}
