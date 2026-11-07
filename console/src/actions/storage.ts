'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import { toDeleteResults } from '@/lib/backend-map';
import type { DeleteResult } from '@/lib/types';
import { asUser, UserError, type ActionResult } from './guard';

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
/** The API takes at most this many items per request (see api/src/storage/storage.controller.ts). */
const BATCH = 500;

type DeleteResponse = {
  deleted: string[];
  skipped: { id: string; reason: string }[];
};

/**
 * Sends a long list in batches of BATCH and joins the answers. "Select all" can pick thousands; one request for all
 * of them is refused by the API's limit. Batches run in order: when one fails, the error says how many were already
 * removed, so the page can show what happened.
 */
async function inBatches(
  items: string[],
  send: (batch: string[]) => Promise<DeleteResponse>,
): Promise<DeleteResponse> {
  const out: DeleteResponse = { deleted: [], skipped: [] };
  for (let i = 0; i < items.length; i += BATCH) {
    try {
      const r = await send(items.slice(i, i + BATCH));
      out.deleted.push(...r.deleted);
      out.skipped.push(...r.skipped);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      throw new UserError(
        `Removed ${out.deleted.length} before this failed: ${message}`,
      );
    }
  }
  return out;
}

export async function deleteVolumesAction(
  names: string[],
  acknowledge: boolean,
): Promise<ActionResult<DeleteResult[]>> {
  return done(
    await asUser(async (token) => {
      const list = z.array(volumeName).min(1).parse(names);
      const r = await inBatches(list, (batch) =>
        api<DeleteResponse>('system/storage/volumes/delete', {
          method: 'POST',
          token,
          body: {
            names: batch,
            acknowledgeUnknownOwner: acknowledge,
          },
        }),
      );
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
      const list = z.array(imageId).min(1).parse(ids);
      const keepCount = keep.parse(keepVersions);
      const r = await inBatches(list, (batch) =>
        api<DeleteResponse>('system/storage/images/delete', {
          method: 'POST',
          token,
          body: {
            imageIds: batch,
            keepVersions: keepCount,
            acknowledgeUnknownOwner: acknowledge,
          },
        }),
      );
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
