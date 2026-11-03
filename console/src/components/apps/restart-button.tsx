'use client';

import { Loader2, RotateCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { restartAppAction } from '@/actions/apps';
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

/** Replaces the running instances with fresh ones. Asks first, because the app is briefly interrupted. */
export function RestartButton({
  appName,
  persistent,
  disabledReason,
}: {
  appName: string;
  /** An app that keeps data stops before its new instance starts */
  persistent: boolean;
  /** Why it cannot be restarted now: stopped, or nothing deployed */
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!!disabledReason}
        title={disabledReason}
        onClick={() => setOpen(true)}
      >
        <RotateCw className="h-4 w-4" /> Restart
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart {appName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {persistent
                ? 'It keeps data, so it runs one instance: the current one stops before the new one starts, and the app is unavailable for a moment.'
                : 'Its instances are replaced one at a time, so it stays available while that happens.'}{' '}
              The image and settings do not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  const res = await restartAppAction(appName);
                  if (!res.ok) return void toast.error(res.error);
                  toast.success(`Restarting ${appName}`);
                  setOpen(false);
                });
              }}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
