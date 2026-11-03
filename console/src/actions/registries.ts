'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import {
  normalizeRegistryDomain,
  registryDomainProblem,
} from '@/lib/registries';
import { asUser, type ActionResult } from './guard';

const domain = z
  .string()
  .transform(normalizeRegistryDomain)
  .superRefine((v, ctx) => {
    const problem = registryDomainProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const user = z.string().trim().min(1, 'Enter the username').max(200);
const secret = z
  .string()
  .min(1, 'Enter the password or access token')
  .max(2000);
const id = z.string().regex(/^r_[a-f0-9]{10}$/, 'Invalid registry');

const done = (result: ActionResult) => {
  if (result.ok) revalidatePath('/settings/registries');
  return result;
};

export interface RegistryInput {
  registryDomain: string;
  registryUser: string;
  /** Required when adding. When editing, empty keeps the saved password. */
  registryPassword: string;
}

/** The API logs in to the registry with these details first, and refuses to save if that fails. */
export async function addRegistryAction(
  input: RegistryInput,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api('registries', {
        method: 'POST',
        token,
        body: {
          domain: domain.parse(input.registryDomain),
          username: user.parse(input.registryUser),
          password: secret.parse(input.registryPassword),
        },
      });
    }),
  );
}

/** The registry's address cannot change: add a new one instead. Blank password keeps the saved one. */
export async function updateRegistryAction(
  registryId: string,
  input: Pick<RegistryInput, 'registryUser' | 'registryPassword'>,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api(`registries/${id.parse(registryId)}`, {
        method: 'PATCH',
        token,
        body: {
          username: user.parse(input.registryUser),
          ...(input.registryPassword
            ? { password: secret.parse(input.registryPassword) }
            : {}),
        },
      });
    }),
  );
}

export async function deleteRegistryAction(
  registryId: string,
): Promise<ActionResult> {
  return done(
    await asUser(async (token) => {
      await api(`registries/${id.parse(registryId)}`, {
        method: 'DELETE',
        token,
      });
    }),
  );
}

export interface PullCheck {
  registry: string;
  /** The saved login that was used, or null when none matched */
  user: string | null;
  pull: { ok: true } | { ok: false; reason: string };
}

/** Asks the registry, through the API, whether the saved login lets this server pull an image. Pulls nothing. */
export async function checkPullAction(
  image: string,
): Promise<ActionResult<PullCheck>> {
  return asUser((token) =>
    api<PullCheck>('registries/check', {
      method: 'POST',
      token,
      body: { image: String(image).trim() },
    }),
  );
}
