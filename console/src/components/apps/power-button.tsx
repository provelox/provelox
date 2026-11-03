'use client';

import { Loader2, Play, Square } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateAppAction } from '@/actions/apps';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/** Stops a running app (after asking) or starts a stopped one. Starting brings back one instance. */
export function PowerButton({
  appName,
  running,
  persistent,
}: {
  appName: string;
  /** It has instances wanted: stopping is on offer. Otherwise starting is. */
  running: boolean;
  persistent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function set(instances: number, done: string) {
    startTransition(async () => {
      const res = await updateAppAction(appName, { instanceCount: instances });
      if (!res.ok) return void toast.error(res.error);
      toast.success(done);
      setOpen(false);
    });
  }

  if (!running)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => set(1, `Started ${appName}`)}
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}{' '}
        Start
      </Button>
    );

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Square className="h-4 w-4" /> Stop
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {appName}?</AlertDialogTitle>
            <AlertDialogDescription>
              It becomes unavailable until you start it again.{' '}
              {persistent
                ? 'Its data is kept.'
                : 'Starting it brings back one instance: set more on the Overview if it ran several.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                set(0, `Stopped ${appName}`);
              }}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
