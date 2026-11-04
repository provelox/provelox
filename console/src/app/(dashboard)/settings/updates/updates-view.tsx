'use client';

import {
  CheckCircle2,
  CircleArrowUp,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  checkReleaseAction,
  releaseStatusAction,
  setUpdateCheckAction,
  startUpdateAction,
} from '@/actions/updates';
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiIsUp } from '@/components/waiting-screen';
import type { ReleaseStatus } from '@/lib/backend';
import { timeAgo } from '@/lib/format';
import {
  advance,
  confirmLines,
  noticeOf,
  POLL_MS,
  START,
  UPDATE_DOCS,
  type Progress,
} from '@/lib/updates';
import { formatVersion } from '@/lib/version';

const link = 'font-medium underline underline-offset-4 hover:no-underline';

/** The release this server runs, the newest one known, and the one button that starts an update. */
export function UpdatesView({ initial }: { initial: ReleaseStatus }) {
  const [status, setStatus] = useState(initial);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>(START);
  const [pending, startTransition] = useTransition();
  const notice = noticeOf(status);

  // While a release installs: watch the API go away and come back, and see which release it is running then
  useEffect(() => {
    if (!target) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let p: Progress = START;
    const tick = async () => {
      const up = await apiIsUp();
      let running: string | null = null;
      if (up === true) {
        try {
          const r = await releaseStatusAction();
          if (r.ok) running = r.data?.current ?? null;
        } catch {
          // restarting again: the next look will know
        }
      }
      if (stop) return;
      p = advance(p, { up, running }, target);
      setProgress(p);
      if (p.phase === 'done') setTimeout(() => window.location.reload(), 900);
      else if (p.phase === 'updating') timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [target]);

  const checkNow = () =>
    startTransition(async () => {
      setError(undefined);
      const r = await checkReleaseAction();
      if (!r.ok || !r.data) return setError(r.ok ? undefined : r.error);
      setStatus(r.data);
      toast.success(
        r.data.error
          ? 'Could not check'
          : r.data.updateAvailable
            ? `${r.data.latest} is available`
            : 'Up to date',
      );
    });

  const toggle = (on: boolean) =>
    startTransition(async () => {
      setError(undefined);
      const r = await setUpdateCheckAction(on);
      if (!r.ok || !r.data) return setError(r.ok ? undefined : r.error);
      setStatus(r.data);
      toast.success(on ? 'Checking for new releases' : 'No longer checking');
    });

  const start = () =>
    startTransition(async () => {
      if (!notice) return;
      setError(undefined);
      const r = await startUpdateAction(notice.latest);
      setConfirming(false);
      if (!r.ok) return setError(r.error);
      setProgress(START);
      setTarget(notice.latest);
    });

  if (target)
    return (
      <Installing target={target} progress={progress} from={status.current} />
    );

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Version</CardTitle>
          <CardDescription>
            {status.current
              ? 'What this server runs, and the newest stable release the project has published.'
              : 'This server was not built from a release (a developer’s build), so it has no release to compare with.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Running</dt>
            <dd data-testid="running-version">
              {formatVersion(status.current)}
            </dd>
            <dt className="text-muted-foreground">Newest release</dt>
            <dd data-testid="latest-version">
              {status.latest ? formatVersion(status.latest) : 'not known yet'}
              {status.publishedAt && (
                <span
                  className="text-muted-foreground"
                  suppressHydrationWarning
                >
                  {' '}
                  (published {timeAgo(status.publishedAt)})
                </span>
              )}
            </dd>
          </dl>

          {notice ? (
            <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <CircleArrowUp
                  className="h-4 w-4 text-primary"
                  aria-hidden="true"
                />
                Provelox {notice.latest} is available
              </p>
              {status.imageMoved ? (
                <p>
                  This server runs the image under its old name, which gets no
                  more releases, so it cannot update itself. Move it once by
                  hand, with the same options as the first install:{' '}
                  <a
                    href={UPDATE_DOCS.oldImage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={link}
                  >
                    how to move it
                  </a>
                  .
                </p>
              ) : !status.canUpdate ? (
                <p>
                  The API does not run as a Swarm service here, so it cannot
                  update itself. Run the install command again with{' '}
                  {notice.latest}:{' '}
                  <a
                    href={UPDATE_DOCS.upgrading}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={link}
                  >
                    upgrading
                  </a>
                  .
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => setConfirming(true)}
                    disabled={pending}
                  >
                    Update to {notice.latest}…
                  </Button>
                  {notice.careful && (
                    <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                      <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                      Copy the data volume first
                    </span>
                  )}
                </div>
              )}
              {notice.notesUrl && (
                <p>
                  <a
                    href={notice.notesUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={link}
                  >
                    What changed in {notice.latest}
                  </a>
                </p>
              )}
            </div>
          ) : (
            status.enabled &&
            status.latest &&
            status.current && (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                You are on the newest release.
              </p>
            )
          )}

          {status.error && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {status.error}
              {status.latest
                ? ' What is shown above is from the last time it worked.'
                : ''}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={checkNow}
              disabled={pending || !status.enabled}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Check
              now
            </Button>
            <span
              className="text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              {status.enabled
                ? status.checkedAt
                  ? `Last checked ${timeAgo(status.checkedAt)}.`
                  : status.checking
                    ? 'Looking now…'
                    : 'Not checked yet.'
                : 'Checking is off.'}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Looking for new releases</CardTitle>
          <CardDescription>
            At most every few hours this server asks GitHub for the project’s
            newest stable release. GitHub sees this server’s address and the
            name “provelox” with its release number, nothing else. Nothing is
            installed without you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Check for new releases</p>
              <p className="text-xs text-muted-foreground">
                {status.lockedOff
                  ? 'Turned off by UPDATE_CHECK=false in this server’s environment. Remove that to turn it on here.'
                  : 'When off, this server never contacts GitHub for this.'}
              </p>
            </div>
            <Switch
              checked={status.enabled}
              disabled={pending || status.lockedOff}
              aria-label="Check for new releases"
              onCheckedChange={toggle}
            />
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirming}
        onOpenChange={(o) => !pending && setConfirming(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update to {notice?.latest}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {notice &&
                  confirmLines(notice).map((line) => <p key={line}>{line}</p>)}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                start();
              }}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** What the page shows once an update has been accepted: waiting, and then how it ended. */
function Installing({
  target,
  progress,
  from,
}: {
  target: string;
  progress: Progress;
  from: string | null;
}) {
  const phase = progress.phase;
  return (
    <Card data-testid="update-progress">
      <CardHeader>
        <CardTitle>
          {phase === 'done'
            ? `Updated to ${target}`
            : phase === 'rolled-back'
              ? 'The update did not take'
              : `Updating to ${target}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {phase === 'updating' && (
          <>
            <p className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {progress.sawDown
                ? 'Restarting. This page loads again by itself when Provelox is back.'
                : 'Started. The console and the API restart in a moment.'}
            </p>
            <p className="text-muted-foreground">
              Your apps keep running. If the new release does not start, Docker
              puts {from ? `release ${from}` : 'the old release'} back by
              itself.
            </p>
          </>
        )}
        {phase === 'done' && (
          <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Provelox is
            running {target}. Loading the page again…
          </p>
        )}
        {phase === 'rolled-back' && (
          <p>
            Provelox is back, but still on {from ?? 'the old release'}: the new
            release did not become healthy and Docker put the old one back.
            Nothing was lost. Look at the log of the service{' '}
            <code>pvx-provelox</code> to see why, or try again later.
          </p>
        )}
        {phase === 'slow' && (
          <p>
            This is taking longer than expected. Docker either finishes the
            update or puts the old release back by itself; reload this page in a
            few minutes to see which release is running.
          </p>
        )}
        {(phase === 'rolled-back' || phase === 'slow') && (
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
