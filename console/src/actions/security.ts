'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from '@/lib/password-rules';
import { createSession } from '@/lib/session';
import { asUser } from './guard';

export interface ChangePasswordState {
  error?: string;
  done?: boolean;
}

const bytes = (v: string) => new TextEncoder().encode(v).length;

const schema = z
  .object({
    current: z.string().min(1, 'Enter your current password').max(200),
    next: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `Use at least ${MIN_PASSWORD_LENGTH} characters`,
      )
      .refine(
        (v) => bytes(v) <= MAX_PASSWORD_BYTES,
        `Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} characters)`,
      ),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, {
    path: ['confirm'],
    message: 'The two new passwords do not match',
  })
  .refine((v) => v.next !== v.current, {
    path: ['next'],
    message: 'The new password must be different',
  });

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const parsed = schema.safeParse({
    current: formData.get('current') ?? '',
    next: formData.get('next') ?? '',
    confirm: formData.get('confirm') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { current, next } = parsed.data;

  // The API signs everyone out when the password changes and hands back a fresh token for this browser
  const changed = await asUser(async (token) =>
    api<{ token: string }>('auth/change-password', {
      method: 'POST',
      token,
      body: { oldPassword: current, newPassword: next },
    }),
  );
  if (!changed.ok || !changed.data)
    return { error: changed.ok ? 'Something went wrong' : changed.error };
  await createSession(changed.data.token);

  revalidatePath('/', 'layout');
  return { done: true };
}
