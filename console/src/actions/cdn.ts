'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { cdnId, parseRanges, type CdnProvider } from '@/lib/cdn';
import { asUser, UserError, type ActionResult } from './guard';

const header = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, 'A header name uses letters, numbers and -')
  .or(z.literal(''));

const customCdn = z.object({
  label: z.string().trim().min(1, 'Give it a name.').max(60),
  clientIpHeader: header,
  /** Either an address that serves the ranges, or the ranges themselves */
  url: z
    .string()
    .trim()
    .url('Enter a full address, like https://example.com/ips.txt')
    .max(500)
    .optional(),
  ranges: z.string().max(100_000).optional(),
});

/** Fetches every CDN's ranges again now, and returns the fresh list. */
export async function refreshCdnAction(): Promise<ActionResult<CdnProvider[]>> {
  const result = await asUser(async (token) => {
    const r = await api<{ providers: CdnProvider[] }>('cdn/refresh', {
      method: 'POST',
      token,
    });
    return r.providers;
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

/** Adds or replaces a CDN Provelox does not know, and returns its id. */
export async function saveCdnProviderAction(
  input: z.input<typeof customCdn>,
): Promise<ActionResult<string>> {
  const result = await asUser(async (token) => {
    const c = customCdn.parse(input);
    if (!!c.url === !!c.ranges?.trim())
      throw new UserError(
        'Give either an address to fetch the ranges from, or the ranges.',
      );
    const id = cdnId(c.label);
    if (!id) throw new UserError('Use letters or numbers in the name.');
    let body: Record<string, unknown> = {
      label: c.label,
      clientIpHeader: c.clientIpHeader || null,
    };
    if (c.url) body = { ...body, url: c.url };
    else {
      const parsed = parseRanges(c.ranges ?? '');
      if (!parsed.ok) throw new UserError(parsed.error);
      body = { ...body, cidrs: parsed.ranges };
    }
    await api(`cdn/providers/${id}`, { method: 'PUT', token, body });
    return id;
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

export async function removeCdnProviderAction(
  id: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(
      `cdn/providers/${z
        .string()
        .regex(/^[a-z0-9-]{1,32}$/)
        .parse(id)}`,
      {
        method: 'DELETE',
        token,
      },
    );
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}
