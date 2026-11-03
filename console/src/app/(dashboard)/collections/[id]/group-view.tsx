'use client';

import {
  CircleMinus,
  LibraryBig,
  MoreHorizontal,
  Pencil,
  Plus,
  Layers,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteGroupAction,
  moveAppToGroupAction,
  renameGroupAction,
} from '@/actions/groups';
import { AppsCollection } from '@/components/apps/apps-collection';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { groupDeleteEffects } from '@/lib/delete-effects';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { GroupsFile } from '@/lib/groups';
import { statusOf, type AppRow } from '../../apps/app-row';
import { GroupAppsDialog } from '@/components/projects/group-apps';
import { GroupNameDialog } from '../../apps/group-name-dialog';
import { NewAppDialog } from '../../apps/new-app-dialog';

export function GroupView({
  group,
  rows,
  groups,
  candidates,
  allApps,
  rootDomain,
  defaultSubdomain,
}: {
  group: { id: string; name: string };
  rows: AppRow[];
  groups: GroupsFile;
  /** Apps that are in no group yet, which can be added here */
  candidates: string[];
  allApps: string[];
  rootDomain: string;
  defaultSubdomain: boolean;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [grouping, setGrouping] = useState<{
    apps: string[];
    pick: boolean;
  } | null>(null);
  const [clearTicks, setClearTicks] = useState<(() => void) | null>(null);
  const [serverError, setServerError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const running = rows.filter((r) => statusOf(r) === 'running').length;

  const add = (n: string) =>
    startTransition(async () => {
      const res = await moveAppToGroupAction(n, group.id);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Added ${n} to ${group.name}`);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[{ label: 'Apps', href: '/apps' }, { label: group.name }]}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{group.name}</h1>
            <p className="text-sm text-muted-foreground">
              {rows.length === 0
                ? 'No apps in this collection yet'
                : `${rows.length} ${rows.length === 1 ? 'app' : 'apps'}, ${running} running`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild size="sm">
              <Link href={`/collections/${group.id}?new=1&group=${group.id}`}>
                <Plus className="h-4 w-4" /> New app
              </Link>
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="More actions"
                  disabled={pending}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {candidates.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <LibraryBig className="h-4 w-4" /> Add an existing app
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                      {candidates.map((n) => (
                        <DropdownMenuItem key={n} onSelect={() => add(n)}>
                          {n}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {rows.length > 0 && (
                  <DropdownMenuItem
                    onSelect={() =>
                      setGrouping({ apps: rows.map((r) => r.name), pick: true })
                    }
                  >
                    <Layers className="h-4 w-4" /> Move apps into a project…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil className="h-4 w-4" /> Rename…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleting(true)}
                >
                  <Trash2 className="h-4 w-4" /> Delete collection…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            Nothing in {group.name} yet
          </p>
          <p className="mt-1">
            Create an app here, or move existing ones in from the Apps page or
            an app&apos;s header.
          </p>
        </div>
      ) : (
        <AppsCollection
          rows={rows}
          bulk={{
            label: 'Move into a project…',
            icon: <Layers className="h-4 w-4" />,
            run: (names, done) => {
              setClearTicks(() => done);
              setGrouping({ apps: names, pick: false });
            },
          }}
          extraMenu={(r, refresh) => (
            <DropdownMenuItem
              onSelect={() =>
                startTransition(async () => {
                  const res = await moveAppToGroupAction(r.name, null);
                  if (!res.ok) return void toast.error(res.error);
                  toast.success(`Removed ${r.name} from ${group.name}`);
                  refresh();
                })
              }
            >
              <CircleMinus className="h-4 w-4" /> Remove from collection
            </DropdownMenuItem>
          )}
        />
      )}

      <GroupAppsDialog
        pick={grouping?.pick}
        apps={grouping?.apps ?? null}
        onClose={() => {
          setGrouping(null);
          clearTicks?.();
          router.refresh();
        }}
      />
      <GroupNameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename collection"
        confirmLabel="Rename"
        initialName={group.name}
        groups={groups}
        exceptId={group.id}
        pending={pending}
        serverError={serverError}
        onSubmit={(name) =>
          startTransition(async () => {
            const res = await renameGroupAction(group.id, name);
            if (!res.ok) return void setServerError(res.error);
            setServerError(undefined);
            setRenaming(false);
            toast.success(`Renamed to ${name}`);
            router.refresh();
          })
        }
      />
      <ConfirmDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete the collection ${group.name}?`}
        name={group.name}
        effects={groupDeleteEffects({ apps: rows.length })}
        confirmLabel="Delete collection"
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const res = await deleteGroupAction(group.id);
            if (!res.ok) return void toast.error(res.error);
            toast.success(`Deleted ${group.name}`);
            router.push('/apps');
          })
        }
      />
      <NewAppDialog
        existingApps={allApps}
        groups={groups}
        rootDomain={rootDomain}
        defaultSubdomain={defaultSubdomain}
        basePath={`/collections/${group.id}`}
      />
    </div>
  );
}
