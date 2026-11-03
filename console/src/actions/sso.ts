'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { ssoId, type SsoProvider } from '@/lib/sso';
import { asUser, UserError, type ActionResult } from './guard';

const provider = z.object({
  kind: z.enum(['google', 'github', 'oidc']),
  label: z.string().trim().min(1, 'Give it a name.').max(60),
  clientId: z.string().trim().min(1, 'Enter the client ID.').max(300),
  clientSecret: z.string().max(1000),
  issuer: z.string().trim().max(300).optional(),
});

/** Adds a sign-in provider, or edits one (a blank secret keeps the saved one), and returns it. */
export async function saveSsoProviderAction(
  input: z.input<typeof provider> & { id?: string },
): Promise<ActionResult<SsoProvider>> {
  const result = await asUser(async (token) => {
    const p = provider.parse(input);
    const id = input.id ?? ssoId(p.label);
    if (!id) throw new UserError('Use letters or numbers in the name.');
    if (!input.id && !p.clientSecret)
      throw new UserError('Enter the client secret.');
    if (p.kind === 'oidc' && !p.issuer)
      throw new UserError('Enter the issuer address.');
    return api<SsoProvider>(`sso/providers/${id}`, {
      method: 'PUT',
      token,
      body: {
        kind: p.kind,
        label: p.label,
        clientId: p.clientId,
        ...(p.clientSecret ? { clientSecret: p.clientSecret } : {}),
        ...(p.kind === 'oidc' ? { issuer: p.issuer } : {}),
      },
    });
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

export async function removeSsoProviderAction(
  id: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(
      `sso/providers/${z
        .string()
        .regex(/^[a-z0-9-]{1,32}$/)
        .parse(id)}`,
      { method: 'DELETE', token },
    );
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}
