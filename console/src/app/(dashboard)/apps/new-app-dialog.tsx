'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { GroupsFile } from '@/lib/groups';

// The wizard is most of this dialog's code and the dialog is closed nearly always: fetched when it opens
const NewAppWizard = dynamic(
  () => import('./new/new-app-wizard').then((m) => m.NewAppWizard),
  { ssr: false },
);

/** The create-app wizard in a modal, open while the URL has ?new=1 (so links and the palette can open it). */
export function NewAppDialog({
  existingApps,
  groups,
  rootDomain,
  defaultSubdomain,
  basePath = '/apps',
}: {
  existingApps: string[];
  groups: GroupsFile;
  rootDomain: string;
  /** The platform's setting: whether a new app starts with a default address */
  defaultSubdomain: boolean;
  /** Where closing the dialog goes back to: the page it was opened from */
  basePath?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get('new') === '1';
  const group = params.get('group');
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => router.replace(basePath), [router, basePath]);
  const initialGroupId = groups.groups.some((g) => g.id === group)
    ? group
    : null;

  return (
    <Dialog
      open={open}
      // Closing while the app is being created would lose the one-time CI key
      onOpenChange={(o) => !o && !busy && close()}
    >
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"
        // A stray click outside must not throw away what has been typed
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Create an app</DialogTitle>
          <DialogDescription>
            A few quick steps from a name to a running deploy.
          </DialogDescription>
        </DialogHeader>
        <NewAppWizard
          existingApps={existingApps}
          groups={groups.groups.map(({ id, name }) => ({ id, name }))}
          initialGroupId={initialGroupId}
          rootDomain={rootDomain}
          defaultSubdomain={defaultSubdomain}
          onClose={close}
          onBusyChange={setBusy}
        />
      </DialogContent>
    </Dialog>
  );
}
