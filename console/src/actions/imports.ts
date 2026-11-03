'use server';

import { z } from 'zod';
import { api } from '@/lib/backend';
import { isImportFileName, type ImportsListing } from '@/lib/volume-import';
import { asUser, UserError, type ActionResult } from './guard';

/** What is in the import folder on the server (read-only), newest first, and how much room the disk has. */
export async function listImportsAction(): Promise<
  ActionResult<ImportsListing>
> {
  return asUser((token) => api<ImportsListing>('system/imports', { token }));
}

const fileName = z.string().max(200);

/** Deletes one file from the import folder. Cannot be undone: the name is sent again as the confirmation. */
export async function deleteImportAction(
  file: string,
): Promise<ActionResult<{ removed: true }>> {
  const f = fileName.parse(file);
  if (!isImportFileName(f))
    throw new UserError('That is not a file name the folder can hold.');
  return asUser((token) =>
    api<{ removed: true }>(
      `system/imports/${encodeURIComponent(f)}?confirm=${encodeURIComponent(f)}`,
      { method: 'DELETE', token },
    ),
  );
}
