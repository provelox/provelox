'use client';

import { useQuery } from '@tanstack/react-query';
import { History, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DeployFailure } from '@/components/deploy-failure';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { SCOPED_BOX_FOCUS, scopedSelectAll } from '@/lib/scoped-select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { deployImageAction } from '@/actions/apps';
import { apiGet } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import type { AppDefinition, BuildStatus } from '@/lib/types';

const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/;

export function DeployPanel({
  appName,
  lastImage,
  versions,
  currentVersion,
}: {
  appName: string;
  lastImage: string;
  versions: AppDefinition['versions'];
  /** The version running now: it cannot be rolled back to */
  currentVersion: number;
}) {
  const router = useRouter();
  const [image, setImage] = useState(lastImage);
  const [starting, startTransition] = useTransition();
  const [watching, setWatching] = useState(false);
  const [rollback, setRollback] = useState<{
    version: number;
    image: string;
  } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const status = useQuery({
    queryKey: ['build', appName],
    queryFn: () => apiGet<BuildStatus>(`deployment/${appName}`),
    // Poll fast while a deploy is in flight, otherwise just check once
    refetchInterval: (q) =>
      watching || q.state.data?.isAppBuilding ? 2000 : false,
  });

  const building = !!status.data?.isAppBuilding;

  // A watched deploy that has finished: report the outcome once
  useEffect(() => {
    if (!watching || !status.data || status.data.isAppBuilding) return;
    setWatching(false);
    if (status.data.isBuildFailed)
      toast.error('Deploy failed, see the log below');
    else {
      toast.success('Deploy finished');
      router.refresh();
    }
  }, [watching, status.data, router]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status.data?.logs.lines.length]);

  function deploy(target = image) {
    startTransition(async () => {
      const res = await deployImageAction(appName, target);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setWatching(true);
      await status.refetch();
    });
  }

  const lines = (status.data?.logs.lines ?? []).filter(Boolean);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="flex flex-col gap-5 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Deploy an image</CardTitle>
            <CardDescription>
              Pull and run a Docker image, for example one pushed by your CI.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                deploy();
              }}
            >
              <Input
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="ghcr.io/org/app:tag"
                className="font-mono"
                aria-label="Image name"
              />
              <Button
                type="submit"
                disabled={!IMAGE_RE.test(image.trim()) || starting || building}
              >
                {(starting || building) && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {building ? 'Deploying' : 'Deploy'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-col items-start sm:flex-row sm:items-center justify-between">
            <CardTitle>Build log</CardTitle>
            <div className="flex items-center gap-2">
              <CopyButton
                value={() => lines.join('\n')}
                disabled={lines.length === 0}
              />
              {building ? (
                <Badge variant="warning">in progress</Badge>
              ) : status.data?.isBuildFailed ? (
                <Badge variant="destructive">failed</Badge>
              ) : (
                <Badge variant="success">idle</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!building && status.data?.isBuildFailed && (
              <DeployFailure lines={lines} />
            )}
            <pre
              ref={logRef}
              {...scopedSelectAll}
              className={`max-h-80 overflow-auto rounded-sm bg-muted p-3 font-mono text-xs leading-relaxed ${SCOPED_BOX_FOCUS}`}
            >
              {lines.length ? lines.join('\n') : 'No build output yet.'}
            </pre>
          </CardContent>
        </Card>
      </div>

      <Card className="self-start">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Version history
          </CardTitle>
          <CardDescription>
            Roll back to an earlier image if a deploy goes wrong.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y text-sm">
          {versions.length === 0 && (
            <p className="py-2 text-muted-foreground">Nothing deployed yet.</p>
          )}
          {versions.map((v) => {
            const current = v.version === currentVersion;
            const image = v.deployedImageName ?? '';
            return (
              <div
                key={v.version}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{v.version}</span>
                    {current && <Badge variant="success">current</Badge>}
                  </div>
                  <p
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={image}
                  >
                    {image || '(placeholder)'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {timeAgo(v.timeStamp)}
                  </p>
                </div>
                {!current && image && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={starting || building}
                    onClick={() => setRollback({ version: v.version, image })}
                  >
                    Roll back
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <AlertDialog
        open={rollback !== null}
        onOpenChange={(o) => !o && setRollback(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Roll back to v{rollback?.version}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <p>
                  <span className="font-mono text-xs">{rollback?.image}</span>{' '}
                  is deployed again, as a new version. The versions after it
                  stay in the history.
                </p>
                <p>Settings and data are not rolled back, only the image.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rollback) deploy(rollback.image);
                setRollback(null);
              }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
