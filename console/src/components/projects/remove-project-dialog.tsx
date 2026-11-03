'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { removeProjectAction } from '@/actions/projects';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { projectRemoveEffects } from '@/lib/delete-effects';

/**
 * Removing a project takes all its services and its private network with it, and asks for the project's name like
 * every deletion. Its data is kept unless the person ticks the box: that part cannot be undone.
 */
export function RemoveProjectDialog({
  project,
  services,
  open,
  onOpenChange,
  onRemoved,
}: {
  project: string;
  /** The apps that go with it, for the person to see */
  services: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setDeleteData(false);
        onOpenChange(o);
      }}
      title={`Remove the project ${project}?`}
      name={project}
      effects={projectRemoveEffects({ services, deleteData })}
      confirmLabel={deleteData ? 'Remove project and data' : 'Remove project'}
      pending={pending}
      onConfirm={() =>
        startTransition(async () => {
          const res = await removeProjectAction(project, { deleteData });
          if (!res.ok) return void toast.error(res.error);
          const d = res.data;
          if (deleteData && d?.keptVolumes.length)
            toast.warning(
              `Removed ${project}, but could not delete ${d.keptVolumes.join(', ')}. Remove it from Storage & cleanup.`,
            );
          else
            toast.success(
              deleteData
                ? `Removed ${project} and its data`
                : `Removed ${project}. Its data was kept.`,
            );
          setDeleteData(false);
          onOpenChange(false);
          onRemoved();
        })
      }
    >
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <Checkbox
          checked={deleteData}
          onCheckedChange={(c) => setDeleteData(c === true)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Also delete its data volumes</span>
          <span className="block text-muted-foreground">
            Databases and uploads stored by this project are erased for good.
          </span>
        </span>
      </label>
    </ConfirmDeleteDialog>
  );
}
