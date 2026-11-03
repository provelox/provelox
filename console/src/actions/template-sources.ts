'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import type { TemplateSource } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const sourceId = z.string().regex(/^ts_[a-f0-9]{10}$/, 'Invalid registry');

const input = z.object({
  kind: z.enum(['index', 'git']),
  name: z.string().trim().max(60).optional(),
  url: z.string().trim().min(1, 'Enter an address.').max(500),
  ref: z.string().trim().max(100).optional(),
  path: z.string().trim().max(200).optional(),
  token: z.string().max(2000).optional(),
});
export type TemplateSourceInput = z.input<typeof input>;

async function run<T>(
  fn: (token: string) => Promise<T>,
): Promise<ActionResult<T>> {
  const result = await asUser(fn);
  if (result.ok) revalidatePath('/templates');
  return result;
}

/** Adds a registry. It is read first, so one that cannot be read is refused with the reason. */
export async function addTemplateSourceAction(
  raw: TemplateSourceInput,
): Promise<ActionResult<TemplateSource>> {
  return run(async (token) => {
    const d = input.parse(raw);
    return api<TemplateSource>('templates/sources', {
      method: 'POST',
      token,
      body: {
        kind: d.kind,
        url: d.url,
        ...(d.name ? { name: d.name } : {}),
        ...(d.kind === 'git' && d.ref ? { ref: d.ref } : {}),
        ...(d.kind === 'git' && d.path ? { path: d.path } : {}),
        ...(d.token ? { token: d.token } : {}),
      },
    });
  });
}

export async function refreshTemplateSourceAction(
  id: string,
): Promise<ActionResult<TemplateSource>> {
  return run((token) =>
    api<TemplateSource>(`templates/sources/${sourceId.parse(id)}/refresh`, {
      method: 'POST',
      token,
    }),
  );
}

export async function removeTemplateSourceAction(
  id: string,
): Promise<ActionResult> {
  return run(async (token) => {
    await api(`templates/sources/${sourceId.parse(id)}`, {
      method: 'DELETE',
      token,
    });
  });
}
