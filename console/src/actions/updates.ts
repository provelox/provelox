'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api, type ReleaseStatus } from '@/lib/backend';
import { asUser, type ActionResult } from './guard';

const release = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,20})?$/,
    'That is not a release number.',
  );

/** Looks for a newer release now (the API ignores a second ask within a minute) */
export async function checkReleaseAction(): Promise<
  ActionResult<ReleaseStatus>
> {
  return asUser((token) =>
    api<ReleaseStatus>('system/release/check', { method: 'POST', token }),
  );
}

/** What the API knows now: the Updates page asks while a release is installing, to see which one is running */
export async function releaseStatusAction(): Promise<
  ActionResult<ReleaseStatus>
> {
  return asUser((token) => api<ReleaseStatus>('system/release', { token }));
}

/** Turns checking for new releases on or off. The notice in every page follows. */
export async function setUpdateCheckAction(
  enabled: boolean,
): Promise<ActionResult<ReleaseStatus>> {
  const result = await asUser(async (token) => {
    await api('system/release/settings', {
      method: 'PUT',
      token,
      body: { enabled: z.boolean().parse(enabled) },
    });
    return api<ReleaseStatus>('system/release', { token });
  });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

/**
 * Starts moving the console and the API to a release. It only goes forward and only after the registry has been asked
 * whether the image can be pulled. The answer comes before the restart; what follows is watched from the page.
 */
export async function startUpdateAction(
  version: string,
): Promise<ActionResult<{ from: string; to: string }>> {
  return asUser((token) =>
    api<{ from: string; to: string }>('system/update', {
      method: 'POST',
      token,
      body: { version: release.parse(version) },
    }),
  );
}
