'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { asUser, UserError, type ActionResult } from './guard';

export interface CreateKeyState {
  error?: string;
  created?: { key: string; name: string; appName: string };
}

const schema = z.object({
  name: z.string().trim().min(1, 'Give the key a name').max(60),
  appName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Choose an app'),
  // The image repository the key may deploy. Empty means the app's current image.
  repository: z.string().trim().max(300),
});

export async function createApiKeyAction(
  _prev: CreateKeyState,
  formData: FormData,
): Promise<CreateKeyState> {
  const parsed = schema.safeParse({
    name: formData.get('name'),
    appName: formData.get('appName'),
    repository: formData.get('repository') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { name, appName, repository } = parsed.data;

  const result = await asUser((token) =>
    api<{ key: string }>('ci-keys', {
      method: 'POST',
      token,
      body: repository
        ? { app: appName, name, repository }
        : { app: appName, name },
    }),
  );

  if (!result.ok || !result.data)
    return { error: result.ok ? 'Something went wrong' : result.error };
  revalidatePath('/settings/access');
  revalidatePath('/apps/[name]', 'layout');
  return { created: { key: result.data.key, name, appName } };
}

export async function revokeApiKeyAction(id: string): Promise<ActionResult> {
  return asUser(async (token) => {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new UserError('Invalid key');
    await api(`ci-keys/${id}`, { method: 'DELETE', token });
    revalidatePath('/settings/access');
    revalidatePath('/apps/[name]', 'layout');
  });
}
