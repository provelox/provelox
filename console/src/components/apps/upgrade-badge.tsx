'use client';

import { ArrowUpCircle, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { deployImageAction } from '@/actions/apps';
import { ImageUpdateBadge } from '@/components/apps/image-update-badge';
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
import { apiGet } from '@/lib/client-api';
import {
  updateLabel,
  updateTitle,
  updateTone,
  type ImageUpdate,
} from '@/lib/image-updates';
import { upgradeTarget } from '@/lib/upgrade';
import type { BuildStatus } from '@/lib/types';

/** Follows the rollout until it ends: true when it went through. Gives up (true) after five minutes of waiting. */
async function untilDeployed(app: string): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const s = await apiGet<BuildStatus>(`deployment/${app}`);
      if (!s.isAppBuilding) return !s.isBuildFailed;
    } catch {
      // a moment where the API cannot answer: keep waiting
    }
  }
  return true;
}

/**
 * The "newer image" badge as a button: it asks for confirmation, then deploys the newer image and says how it went.
 * Falls back to the plain badge where an upgrade cannot be done from here.
 */
export function UpgradeBadge({
  app,
  image,
  update,
  persistent,
  project,
}: {
  app: string;
  /** What the app runs now, as deployed */
  image: string | undefined;
  update: ImageUpdate | undefined;
  persistent?: boolean;
  project?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = updateLabel(update);
  const target = upgradeTarget(image, update);
  if (!update || !label) return null;
  if (!target) return <ImageUpdateBadge update={update} />;

  const major = update.latest?.kind === 'major';
  const rebuilt = !update.latest;

  async function upgrade() {
    setBusy(true);
    const id = toast.loading(`Upgrading ${app}…`);
    const res = await deployImageAction(app, target as string);
    if (!res.ok) {
      toast.error(res.error, { id });
      setBusy(false);
      return;
    }
    setOpen(false);
    router.refresh();
    const ok = await untilDeployed(app);
    if (ok) toast.success(`${app} is upgraded`, { id });
    else
      toast.error(
        `Upgrading ${app} failed. Open its Deployments tab for the log.`,
        {
          id,
        },
      );
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        title={`${updateTitle(update)} Click to upgrade.`}
        aria-label={`Upgrade ${app} to ${label}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium hover:brightness-95 ${updateTone(update)}`}
      >
        <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
        {label}
      </button>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rebuilt ? `Redeploy ${app}?` : `Upgrade ${app} to ${label}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Now</dt>
                  <dd className="break-all font-mono text-xs">{image}</dd>
                  <dt className="text-muted-foreground">After</dt>
                  <dd className="break-all font-mono text-xs">{target}</dd>
                </dl>
                <p>
                  {rebuilt
                    ? 'The registry holds a newer build under the same tag. It is pulled and the app restarts on it.'
                    : 'The new image is pulled and the app restarts on it, so it is briefly unavailable. Settings, domains and data volumes are kept.'}
                </p>
                {major && (
                  <p className="text-amber-600 dark:text-amber-400">
                    This is a major update: it may change how the app behaves.
                    Read its release notes first.
                  </p>
                )}
                {persistent && (
                  <p className="text-amber-600 dark:text-amber-400">
                    This app keeps data on a volume. A new version can migrate
                    that data in a way older versions cannot read: back it up
                    first.
                  </p>
                )}
                {project && (
                  <p className="text-muted-foreground">
                    It belongs to the project <strong>{project}</strong>.
                    Updating the project later from its compose file would put
                    the image in that file back, so change it there too.
                  </p>
                )}
                <p className="text-muted-foreground">
                  If it does not start, roll back from the app&apos;s
                  Deployments tab.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void upgrade();
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {rebuilt ? 'Redeploy' : 'Upgrade'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
