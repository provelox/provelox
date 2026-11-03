'use client';

import { Library, LibraryBig } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createGroupAction, moveAppToGroupAction } from '@/actions/groups';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { GroupsFile } from '@/lib/groups';
import { GroupNameDialog } from '../group-name-dialog';

/** Shows which group an app is in and lets you change it. */
export function GroupPicker({
  appName,
  groups,
  groupId,
}: {
  appName: string;
  groups: GroupsFile;
  groupId: string | null;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [serverError, setServerError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const current = groups.groups.find((g) => g.id === groupId);

  const move = (id: string | null) =>
    startTransition(async () => {
      const res = await moveAppToGroupAction(appName, id);
      if (!res.ok) return void toast.error(res.error);
      toast.success(
        id ? 'Moved to the collection' : 'Removed from its collection',
      );
      router.refresh();
    });

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            <Library className="h-4 w-4" />
            {current ? current.name : 'No collection'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuRadioGroup
            value={groupId ?? 'none'}
            onValueChange={(v) =>
              v !== (groupId ?? 'none') && move(v === 'none' ? null : v)
            }
          >
            <DropdownMenuRadioItem value="none">
              No collection
            </DropdownMenuRadioItem>
            {[...groups.groups]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((g) => (
                <DropdownMenuRadioItem key={g.id} value={g.id}>
                  {g.name}
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setServerError(undefined);
              setCreating(true);
            }}
          >
            <LibraryBig className="h-4 w-4" /> New collection…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <GroupNameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New collection"
        description={`Create a collection and put ${appName} in it.`}
        confirmLabel="Create collection"
        groups={groups}
        pending={pending}
        serverError={serverError}
        onSubmit={(name) =>
          startTransition(async () => {
            const created = await createGroupAction(name);
            if (!created.ok || !created.data)
              return void setServerError(
                created.ok ? 'Could not create the collection' : created.error,
              );
            const moved = await moveAppToGroupAction(appName, created.data);
            if (!moved.ok)
              toast.error(`Collection created, but ${moved.error}`);
            else toast.success(`Moved ${appName} to ${name}`);
            setCreating(false);
            router.refresh();
          })
        }
      />
    </>
  );
}
