'use client';

import { ArrowRight, CheckCircle2, LibraryBig, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { renameAppAction } from '@/actions/apps';
import { moveAppToGroupAction } from '@/actions/groups';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { GroupsFile } from '@/lib/groups';
import { proposeTidyNames, type TidyProposal } from '@/lib/tidy-names';
import { renameFavorite } from '@/lib/use-favorites';
import type { AppRow } from './app-row';

type Outcome = { renamed: boolean; error?: string; moveError?: string };

/**
 * Brings the names of the apps you already have in line with the convention (<product>-<role>, read from the domain
 * each one answers on), after showing exactly what would change. Each rename is the same one the app's own Rename does,
 * run one at a time, and a failure on one leaves the others to carry on: nothing is rolled back.
 */
export function TidyNamesDialog({
  open,
  onOpenChange,
  rows,
  groups,
  rootDomain,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: AppRow[];
  groups: GroupsFile;
  rootDomain: string;
}) {
  const router = useRouter();
  const live = useMemo(
    () =>
      proposeTidyNames({
        apps: rows.map((r) => ({
          name: r.name,
          project: r.project,
          hosts: r.domains.map((d) => d.host),
        })),
        rootDomain,
        collections: groups.groups,
      }),
    [rows, groups, rootDomain],
  );
  // What is shown is fixed when the dialog opens: the list behind it refreshes as apps are renamed, and a row must
  // stay to show how its rename went rather than vanish
  const liveRef = useRef(live);
  liveRef.current = live;
  const [{ proposals, skipped }, setShown] = useState(live);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [update, setUpdate] = useState(true);
  const [keep, setKeep] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const finished = Object.keys(outcomes).length > 0 && !pending;

  // every proposal starts ticked, each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setShown(liveRef.current);
    setChosen(new Set(liveRef.current.proposals.map((p) => p.app)));
    setOutcomes({});
    setUpdate(true);
    setKeep(false);
  }, [open]);

  const toggle = (app: string) =>
    setChosen((c) => {
      const n = new Set(c);
      if (n.has(app)) n.delete(app);
      else n.add(app);
      return n;
    });

  const apply = () =>
    startTransition(async () => {
      for (const p of proposals.filter((x) => chosen.has(x.app))) {
        setRunning(p.app);
        const res = await renameAppAction(p.app, p.to, {
          updateReferences: update,
          keepOldName: keep,
        });
        if (!res.ok) {
          setOutcomes((o) => ({
            ...o,
            [p.app]: { renamed: false, error: res.error },
          }));
          continue;
        }
        renameFavorite(p.app, p.to);
        let moveError: string | undefined;
        if (p.collection) {
          const moved = await moveAppToGroupAction(p.to, p.collection.id);
          if (!moved.ok) moveError = moved.error;
        }
        setOutcomes((o) => ({ ...o, [p.app]: { renamed: true, moveError } }));
      }
      setRunning(null);
      router.refresh();
    });

  const count = proposals.filter((p) => chosen.has(p.app)).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tidy names</DialogTitle>
          <DialogDescription>
            Name each app for what it is, from the domain it answers on:{' '}
            <code>api.loxti.com</code> becomes <code>loxti-api</code>, and{' '}
            <code>loxti.com</code> becomes <code>loxti-web</code>.
          </DialogDescription>
        </DialogHeader>

        {proposals.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            Nothing to tidy: every app with its own domain already has the name
            the convention would give it.
          </p>
        ) : (
          <>
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Each rename restarts that app under its new name, so it is
              unavailable for a moment. Data, secrets, domains and deploy keys
              stay with it, and its default address follows the name.
            </p>
            <ul className="divide-y rounded-md border text-sm">
              {proposals.map((p) => (
                <ProposalRow
                  key={p.app}
                  p={p}
                  checked={chosen.has(p.app)}
                  disabled={pending || finished}
                  onToggle={() => toggle(p.app)}
                  outcome={outcomes[p.app]}
                  running={running === p.app}
                />
              ))}
            </ul>
            <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={update}
                  onCheckedChange={(v) => setUpdate(v === true)}
                  disabled={pending || finished}
                  className="mt-0.5"
                />
                <span>
                  Point other apps at the new names
                  <span className="block text-xs text-muted-foreground">
                    Where another app&apos;s variables name one of these apps (
                    <code>DB_HOST=old-name</code>), they are changed to the new
                    name and that app restarts too. Apps in a project are not
                    touched: edit those in the project.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={keep}
                  onCheckedChange={(v) => setKeep(v === true)}
                  disabled={pending || finished}
                  className="mt-0.5"
                />
                <span>
                  Keep the old names working as second names
                  <span className="block text-xs text-muted-foreground">
                    Anything that still reaches an app by its old name on the
                    network keeps working. Remove the alias later under
                    Networking.
                  </span>
                </span>
              </label>
            </div>
          </>
        )}

        {skipped.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {skipped.length === 1
                ? '1 app is left as it is'
                : `${skipped.length} apps are left as they are`}
            </summary>
            <ul className="mt-2 flex flex-col gap-0.5">
              {skipped.map((s) => (
                <li key={s.app}>
                  <span className="font-medium text-foreground">{s.app}</span>:{' '}
                  {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {finished ? 'Close' : 'Cancel'}
          </Button>
          {proposals.length > 0 && !finished && (
            <Button disabled={pending || count === 0} onClick={apply}>
              {pending
                ? `Renaming ${running ?? ''}…`
                : `Rename ${count} ${count === 1 ? 'app' : 'apps'}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProposalRow({
  p,
  checked,
  disabled,
  onToggle,
  outcome,
  running,
}: {
  p: TidyProposal;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  outcome?: Outcome;
  running: boolean;
}) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        disabled={disabled}
        aria-label={`Rename ${p.app}`}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 font-mono">
          <span className="text-muted-foreground">{p.app}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{p.to}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          from {p.host}
          {p.collection && (
            <span className="ml-2 inline-flex items-center gap-1">
              <LibraryBig className="h-3 w-3" /> also moves to{' '}
              <b>{p.collection.name}</b>
            </span>
          )}
        </p>
        {outcome?.error && (
          <p className="mt-1 text-xs text-destructive">{outcome.error}</p>
        )}
        {outcome?.moveError && (
          <p className="mt-1 text-xs text-destructive">
            Renamed, but not moved to {p.collection?.name}: {outcome.moveError}
          </p>
        )}
      </div>
      <span className="mt-0.5 shrink-0 text-xs" aria-live="polite">
        {outcome?.renamed ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : outcome ? (
          <XCircle className="h-4 w-4 text-destructive" />
        ) : running ? (
          <span className="text-muted-foreground">Renaming…</span>
        ) : null}
      </span>
    </li>
  );
}
