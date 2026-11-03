'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { asUser, UserError, type ActionResult } from './guard';

export interface CreateTokenState {
  error?: string;
  created?: {
    token: string;
    name: string;
    scope: 'read' | 'operate' | 'update';
  };
}

const schema = z.object({
  name: z.string().trim().min(1, 'Give the token a name').max(60),
  scope: z.enum(['read', 'operate', 'update'], {
    message: 'Choose what it may do',
  }),
});

export async function createAccessTokenAction(
  _prev: CreateTokenState,
  formData: FormData,
): Promise<CreateTokenState> {
  const parsed = schema.safeParse({
    name: formData.get('name'),
    scope: formData.get('scope'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const result = await asUser((token) =>
    api<{ token: string }>('system/access-tokens', {
      method: 'POST',
      token,
      body: parsed.data,
    }),
  );
  if (!result.ok || !result.data)
    return { error: result.ok ? 'Something went wrong' : result.error };
  revalidatePath('/settings/access');
  return { created: { token: result.data.token, ...parsed.data } };
}

export async function revokeAccessTokenAction(
  id: string,
): Promise<ActionResult> {
  return asUser(async (token) => {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new UserError('Invalid token');
    await api(`system/access-tokens/${id}`, { method: 'DELETE', token });
    revalidatePath('/settings/access');
  });
}
