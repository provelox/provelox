'use client';

import { Layers, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { GroupAppsDialog } from '@/components/projects/group-apps';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { deleteAppAction } from '@/actions/apps';
import { RemoveProjectDialog } from '@/components/projects/remove-project-dialog';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { appDeleteEffects } from '@/lib/delete-effects';
import { RenameDialog, useRenameOpen } from './rename-app';

/**
 * The less common things to do to an app, kept out of the way beside Restart: rename it, delete it (or, for a service of
 * a project, open or remove the project). Deleting asks for the app's name.
 */
export function AppMenu({
  appName,
  project,
  projectApps = [],
  existingApps,
  facts,
}: {
  appName: string;
  /** Every app's name, so a rename can say when one is taken */
  existingApps: string[];
  project?: string;
  projectApps?: string[];
  /** What deleting takes with it, for the confirmation */
  facts: {
    domains: number;
    defaultAddress: boolean;
    secrets: number;
    volumes: string[];
  };
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useRenameOpen();
  const [deleting, setDeleting] = useState(false);
  const [removingProject, setRemovingProject] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      const res = await deleteAppAction(appName);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Deleted ${appName}`);
      router.replace('/apps');
    });

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {project ? (
            <>
              <DropdownMenuItem asChild>
                <Link href={`/projects/${project}`}>
                  <Layers className="h-4 w-4" /> Open project {project}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setRemovingProject(true)}
              >
                <Trash2 className="h-4 w-4" /> Remove project…
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil className="h-4 w-4" /> Rename…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGrouping(true)}>
                <Layers className="h-4 w-4" /> Move into a project…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleting(true)}
              >
                <Trash2 className="h-4 w-4" /> Delete app…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {!project && (
        <GroupAppsDialog
          apps={grouping ? [appName] : null}
          onClose={() => {
            setGrouping(false);
            router.refresh();
          }}
        />
      )}

      {!project && (
        <RenameDialog
          appName={appName}
          existingApps={existingApps}
          open={renaming}
          onOpenChange={setRenaming}
        />
      )}

      <ConfirmDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${appName}?`}
        name={appName}
        effects={appDeleteEffects(facts)}
        confirmLabel="Delete app"
        pending={pending}
        onConfirm={confirm}
      />

      {project && (
        <RemoveProjectDialog
          project={project}
          services={projectApps}
          open={removingProject}
          onOpenChange={setRemovingProject}
          onRemoved={() => router.replace('/apps')}
        />
      )}
    </>
  );
}
