'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { asUser, type ActionResult } from './guard';

const rootDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, 'That domain is too long')
  .regex(
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Enter just the domain, for example example.com (no https:// and no path)',
  );

const email = z.string().trim().max(254).email('Enter a valid email address');

const done = <T>(result: ActionResult<T>) => {
  if (result.ok) revalidatePath('/', 'layout');
  return result;
};

/** What happened to the console and API when the root domain changed. */
export interface PlatformMove {
  moved: boolean;
  /** Where the console is served now, when it is at the new root domain */
  consoleUrl?: string;
  /** Why they stayed where they were, when the move could not go ahead */
  reason?: string;
}

/**
 * Sets the domain that apps are served under (<app>.<root domain>). Every app's routing is updated, and so are the
 * console and API (console.<root domain>, api.<root domain>) once their new names point here. Create a wildcard DNS
 * record for it first, pointing at this server.
 */
export async function changeRootDomainAction(
  domain: string,
): Promise<ActionResult<{ platform?: PlatformMove }>> {
  return done(
    await asUser((token) =>
      api<{ platform?: PlatformMove }>('system/domain', {
        method: 'PUT',
        token,
        body: { rootDomain: rootDomain.parse(domain) },
      }),
    ),
  );
}

/**
 * Sets a domain of its own for apps' default addresses (<app>.<domain>), apart from the root domain the console and
 * API stay on. Null goes back to the root domain. Every app's routing is updated.
 */
export async function setAppsDomainAction(
  domain: string | null,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api('system/apps-domain', {
        method: 'PUT',
        token,
        body: { appsDomain: domain === null ? null : rootDomain.parse(domain) },
      });
    }),
  );
}

/**
 * Serves the console and the API over HTTPS, for a platform installed without a Let's Encrypt email or moved here from
 * another platform. Needs the email saved and DNS that already leads to this server.
 */
export async function serveOverHttpsAction(): Promise<
  ActionResult<{ changed: string[]; consoleUrl?: string }>
> {
  return done(
    await asUser(async (token) => {
      const r = await api<{
        changed: string[];
        console: { url: string } | null;
      }>('system/platform-https', { method: 'PUT', token });
      return { changed: r.changed, consoleUrl: r.console?.url };
    }),
  );
}

/** The Let's Encrypt account email. Needed before any domain can use HTTPS. */
export async function setAcmeEmailAction(
  address: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api('system/acme-email', {
        method: 'PUT',
        token,
        body: { email: email.parse(address) },
      });
    }),
  );
}

/** Whether apps created from now on are served at <name>.<root domain> by default. Existing apps keep what they have. */
export async function setAppDefaultsAction(
  defaultSubdomain: boolean,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api('system/app-defaults', {
        method: 'PUT',
        token,
        body: { defaultSubdomain: z.boolean().parse(defaultSubdomain) },
      });
    }),
  );
}

const webhookName = z.string().trim().min(1, 'Give the webhook a name').max(60);
const webhookUrl = z
  .string()
  .trim()
  .url('Enter the webhook address, like https://hooks.example.com/abc')
  .refine(
    (u) => /^https?:\/\//.test(u),
    'The address must start with https:// or http://',
  );

export async function addWebhookAction(
  name: string,
  url: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api('system/notifications/webhooks', {
        method: 'POST',
        token,
        body: { name: webhookName.parse(name), url: webhookUrl.parse(url) },
      });
    }),
  );
}

export async function removeWebhookAction(id: string): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api(
        `system/notifications/webhooks/${z
          .string()
          .regex(/^[a-f0-9]{10}$/)
          .parse(id)}`,
        {
          method: 'DELETE',
          token,
        },
      );
    }),
  );
}

/** Sends a sample message to a webhook. The result says how it went. */
export async function testWebhookAction(
  id: string,
): Promise<ActionResult<{ ok: boolean; status: string }>> {
  const result = await asUser(async (token) =>
    api<{ ok: boolean; status: string }>(
      `system/notifications/webhooks/${z
        .string()
        .regex(/^[a-f0-9]{10}$/)
        .parse(id)}/test`,
      { method: 'POST', token },
    ),
  );
  // the webhook now shows how this one went
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

export async function setNotificationEventsAction(
  events: Partial<{
    problem: boolean;
    recovered: boolean;
    certificate: boolean;
  }>,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api('system/notifications/events', {
        method: 'PUT',
        token,
        body: z
          .object({
            problem: z.boolean(),
            recovered: z.boolean(),
            certificate: z.boolean(),
          })
          .partial()
          .parse(events),
      });
    }),
  );
}
