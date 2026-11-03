'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { toDeleteResults } from '@/lib/backend-map';
import type { DeleteResult } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const volumeName = z.string().min(1).max(255);
const imageId = z.string().min(1).max(255);
const keep = z.number().int().min(0).max(50);

const done = <T>(result: ActionResult<T>) => {
  if (result.ok) revalidatePath('/settings/infrastructure');
  return result;
};

/**
 * Removes volumes. The API checks each one again against the live state, so a volume that is in use or
 * mounted by an app is refused even if this request asks for it. `acknowledge` is the user's explicit
 * confirmation for volumes whose owner cannot be proven.
 */
export async function deleteVolumesAction(
  names: string[],
  acknowledge: boolean,
): Promise<ActionResult<DeleteResult[]>> {
  return done(
    await asUser(async (token) => {
      const r = await api<{
        deleted: string[];
        skipped: { id: string; reason: string }[];
      }>('system/storage/volumes/delete', {
        method: 'POST',
        token,
        body: {
          names: z.array(volumeName).min(1).max(500).parse(names),
          acknowledgeUnknownOwner: acknowledge,
        },
      });
      return toDeleteResults(r, 'name');
    }),
  );
}

export async function deleteImagesAction(
  ids: string[],
  keepVersions: number,
  acknowledge: boolean,
): Promise<ActionResult<DeleteResult[]>> {
  return done(
    await asUser(async (token) => {
      const r = await api<{
        deleted: string[];
        skipped: { id: string; reason: string }[];
      }>('system/storage/images/delete', {
        method: 'POST',
        token,
        body: {
          imageIds: z.array(imageId).min(1).max(500).parse(ids),
          keepVersions: keep.parse(keepVersions),
          acknowledgeUnknownOwner: acknowledge,
        },
      });
      return toDeleteResults(r, 'id');
    }),
  );
}

/** What is inside a volume, read-only. */
export async function peekVolumeAction(
  name: string,
): Promise<ActionResult<string>> {
  return asUser(async (token) => {
    const r = await api<{ listing: string }>(
      `system/storage/volumes/peek?name=${encodeURIComponent(volumeName.parse(name))}`,
      { token },
    );
    return r.listing;
  });
}
