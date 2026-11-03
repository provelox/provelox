'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { APP_NAME_RE } from '@/lib/app-name';
import { api } from '@/lib/backend';
import { asUser, type ActionResult } from './guard';

const groupId = z.string().regex(/^g_[a-f0-9]{10}$/, 'Invalid collection');
const appName = z.string().regex(APP_NAME_RE, 'Invalid app name');
const groupName = z.string().max(200);

async function run<T>(
  fn: (token: string) => Promise<T>,
): Promise<ActionResult<T>> {
  const result = await asUser(fn);
  if (result.ok) {
    revalidatePath('/apps');
    revalidatePath('/apps/[name]', 'layout');
    revalidatePath('/collections/[id]', 'page');
  }
  return result;
}

export async function createGroupAction(
  name: string,
): Promise<ActionResult<string>> {
  return run(async (token) => {
    const g = await api<{ id: string }>('groups', {
      method: 'POST',
      token,
      body: { name: groupName.parse(name) },
    });
    return g.id;
  });
}

export async function renameGroupAction(
  id: string,
  name: string,
): Promise<ActionResult> {
  return run(async (token) => {
    await api(`groups/${groupId.parse(id)}`, {
      method: 'PATCH',
      token,
      body: { name: groupName.parse(name) },
    });
  });
}

/** Only the collection goes away: its apps are no longer in a collection. */
export async function deleteGroupAction(id: string): Promise<ActionResult> {
  return run(async (token) => {
    await api(`groups/${groupId.parse(id)}`, { method: 'DELETE', token });
  });
}

/** groupId null takes the app out of its group. */
export async function moveAppToGroupAction(
  name: string,
  id: string | null,
): Promise<ActionResult> {
  return run(async (token) => {
    await api(`apps/${appName.parse(name)}`, {
      method: 'PATCH',
      token,
      body: { groupId: id === null ? null : groupId.parse(id) },
    });
  });
}
