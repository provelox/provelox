'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { BackendError, login } from '@/lib/backend';
import { afterLogin } from '@/lib/after-login';
import { createSession, destroySession } from '@/lib/session';

export interface LoginState {
  error?: string;
}

const schema = z.object({
  password: z.string().min(1, 'Password is required').max(200),
});

/**
 * Who is signing in, from the last hop of X-Forwarded-For (the proxy next to the console wrote it, not the client).
 * Without a proxy the header is the client's own, so set CONSOLE_TRUST_PROXY=false there.
 */
async function clientIp(): Promise<string | null> {
  if (process.env.CONSOLE_TRUST_PROXY === 'false') return null;
  const ip = (await headers()).get('x-forwarded-for')?.split(',').pop()?.trim();
  return ip && ip.length <= 64 ? ip : null;
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({ password: formData.get('password') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const { token } = await login(parsed.data.password, await clientIp());
    await createSession(token);
  } catch (e) {
    if (e instanceof BackendError) return { error: e.message };
    throw e;
  }
  redirect(afterLogin(formData.get('next')));
}

export async function logoutAction() {
  await destroySession();
  redirect('/login');
}
