'use client';

import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  getVolumeMigrationAction,
  releaseVolumeHoldAction,
} from '@/actions/apps';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { VolumeMigration } from '@/lib/types';

/** Live progress of moving data into a named volume. Polls while it runs, and keeps showing the outcome. */
export function MigrationProgress({
  appName,
  initial,
}: {
  appName: string;
  initial: VolumeMigration;
}) {
  const router = useRouter();
  const [migration, setMigration] = useState(initial);
  const wasRunning = useRef(initial.status === 'running');
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    if (migration.status !== 'running') return;
    const timer = setInterval(async () => {
      const res = await getVolumeMigrationAction(appName);
      if (res.ok && res.data) setMigration(res.data);
    }, 1500);
    return () => clearInterval(timer);
  }, [appName, migration.status]);

  useEffect(() => {
    // Only react to a run that finished while this page was open, not to one that was already over on load
    if (!wasRunning.current || migration.status === 'running') return;
    wasRunning.current = false;
    if (migration.status === 'done')
      toast.success('Your data is now on a named volume');
    else
      toast.error(
        migration.rolledBack
          ? 'The move failed. The app was restored; your original data is kept safe.'
          : 'The move failed',
      );
    router.refresh();
  }, [migration.status, migration.rolledBack, router]);

  const running = migration.status === 'running';
  const failed = migration.status === 'failed';

  return (
    <Card
      className={
        failed
          ? 'border-destructive/50'
          : running
            ? 'border-amber-500/50'
            : 'border-emerald-500/40'
      }
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : failed ? (
            <TriangleAlert className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {running
            ? `Moving ${migration.containerPath} to ${migration.toVolume}`
            : failed
              ? 'The move did not complete'
              : `${migration.containerPath} is now on the volume ${migration.toVolume}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {running && (
          <p className="text-sm text-muted-foreground">
            The app is stopped while its data is copied. Please leave the app
            alone until this finishes. Deploys and changes are blocked
            meanwhile, and it is safe to close this page.
          </p>
        )}
        <ol className="flex flex-col gap-1 text-sm">
          {migration.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                {new Date(s.at).toLocaleTimeString()}
              </span>
              <span className="wrap-break-word">{s.text}</span>
            </li>
          ))}
        </ol>
        {failed && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <p className="font-medium">{migration.error}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The app was restored to how it was before the move, and the partly
              copied volume was removed.
            </p>
            {migration.heldVolume && (
              <div className="mt-3 flex flex-col gap-2 border-t border-destructive/30 pt-3 text-xs">
                <p>
                  <strong>Your original data is safe.</strong> The app now runs
                  on a fresh volume, so the original (
                  <code className="break-all font-mono">
                    {migration.heldVolume.slice(0, 12)}…
                  </code>
                  ) may be the only copy. A helper container keeps Docker from
                  deleting it. Release it only when you no longer need that
                  data.
                </p>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={releasing}
                    onClick={() => {
                      setReleasing(true);
                      void releaseVolumeHoldAction(appName).then((res) => {
                        setReleasing(false);
                        if (res.ok) {
                          toast.success('Released');
                          setMigration((m) => ({
                            ...m,
                            heldVolume: undefined,
                          }));
                          router.refresh();
                        } else toast.error(res.error);
                      });
                    }}
                  >
                    {releasing && <Loader2 className="h-4 w-4 animate-spin" />}
                    Release the original data
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {migration.status === 'done' && (
          <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
            Verified: the copy matches the original. Docker removes the old
            unnamed volume together with the old container.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
