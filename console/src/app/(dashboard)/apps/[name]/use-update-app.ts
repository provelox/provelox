'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { updateAppAction } from '@/actions/apps';

type Patch = Parameters<typeof updateAppAction>[1];

/** Sends only the given fields to Provelox. `optimistic` runs inside the transition so the UI updates at once and rolls back on failure. */
export function useUpdateApp(appName: string) {
  const [pending, startTransition] = useTransition();

  function update(patch: Patch, success = 'Saved', optimistic?: () => void) {
    startTransition(async () => {
      optimistic?.();
      const res = await updateAppAction(appName, patch);
      if (res.ok) toast.success(success);
      else toast.error(res.error);
    });
  }
  return { update, pending };
}
