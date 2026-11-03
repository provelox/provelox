'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  api,
  type ClusterOverview,
  type JoinInstructions,
} from '@/lib/backend';
import { asUser, type ActionResult } from './guard';

const nodeId = z.string().regex(/^[a-z0-9]{10,40}$/, 'Invalid machine');
const role = z.enum(['worker', 'manager']);

const done = <T>(result: ActionResult<T>) => {
  if (result.ok) revalidatePath('/settings/infrastructure');
  return result;
};

/** The cluster as it is now, for the dialog that waits for a new server to appear. */
export async function loadClusterAction(): Promise<
  ActionResult<ClusterOverview>
> {
  return asUser((token) => api<ClusterOverview>('system/cluster', { token }));
}

/**
 * What another machine needs to join: the tokens and the commands. Asked for only when the dialog opens, so the
 * tokens are never part of a page that is merely looked at.
 */
export async function loadJoinAction(): Promise<
  ActionResult<JoinInstructions>
> {
  return asUser((token) =>
    api<JoinInstructions>('system/cluster/join', { token }),
  );
}

/** Makes the old token for a role stop working and returns the new one. */
export async function rotateJoinTokenAction(
  r: string,
): Promise<ActionResult<JoinInstructions>> {
  return asUser((token) =>
    api<JoinInstructions>('system/cluster/join/rotate', {
      method: 'POST',
      token,
      body: { role: role.parse(r) },
    }),
  );
}

/** pause: no new work; drain: moves its work elsewhere and keeps it free; active: takes work again. */
export async function setNodeAvailabilityAction(
  id: string,
  availability: string,
): Promise<ActionResult<ClusterOverview>> {
  return done(
    await asUser((token) =>
      api<ClusterOverview>(`system/cluster/nodes/${nodeId.parse(id)}`, {
        method: 'PATCH',
        token,
        body: {
          availability: z
            .enum(['active', 'pause', 'drain'])
            .parse(availability),
        },
      }),
    ),
  );
}

export async function setNodeRoleAction(
  id: string,
  r: string,
): Promise<ActionResult<ClusterOverview>> {
  return done(
    await asUser((token) =>
      api<ClusterOverview>(`system/cluster/nodes/${nodeId.parse(id)}`, {
        method: 'PATCH',
        token,
        body: { role: role.parse(r) },
      }),
    ),
  );
}

export async function removeNodeAction(
  id: string,
): Promise<ActionResult<ClusterOverview>> {
  return done(
    await asUser((token) =>
      api<ClusterOverview>(`system/cluster/nodes/${nodeId.parse(id)}`, {
        method: 'DELETE',
        token,
      }),
    ),
  );
}
