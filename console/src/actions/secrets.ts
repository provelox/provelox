'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { APP_NAME_RE } from '@/lib/app-name';
import { api } from '@/lib/backend';
import { asUser, type ActionResult } from './guard';

const appName = z
  .string()
  .refine((v) => APP_NAME_RE.test(v), 'Invalid app name');
const secretName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    'Use up to 64 letters, numbers, dots, dashes or underscores, starting with a letter or number',
  );
// Docker's limit for one secret
const secretValue = z
  .string()
  .min(1, 'Enter a value')
  .refine(
    (v) => new TextEncoder().encode(v).length <= 500 * 1024,
    'Secrets can be at most 500 KB',
  );

/** Creates a secret, or replaces its value. The value goes straight to Docker and can never be read back. */
export async function setAppSecretAction(
  name: string,
  secret: string,
  value: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(
      `apps/${appName.parse(name)}/secrets/${encodeURIComponent(secretName.parse(secret))}`,
      { method: 'PUT', token, body: { value: secretValue.parse(value) } },
    );
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}

export async function deleteAppSecretAction(
  name: string,
  secret: string,
): Promise<ActionResult> {
  const result = await asUser(async (token) => {
    await api(
      `apps/${appName.parse(name)}/secrets/${encodeURIComponent(secretName.parse(secret))}`,
      { method: 'DELETE', token },
    );
  });
  if (result.ok) revalidatePath('/apps/[name]', 'layout');
  return result;
}
