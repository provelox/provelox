'use client';

import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  groupAppsAction,
  listMovableAppsAction,
  listProjectNamesAction,
  type GroupedApps,
} from '@/actions/projects';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DeployMode } from './deploy-project-dialog';

// Fetched the first time it is asked for
const DeployProjectDialog = dynamic(
  () => import('./deploy-project-dialog').then((m) => m.DeployProjectDialog),
  { ssr: false },
);

const NEW = '';

/** Turns what the server made of the apps into the dialog that reviews it. */
export function modeFor(
  project: string | null,
  g: GroupedApps,
  runningValues: Record<string, string> = {},
): DeployMode {
  const notes = [
    ...g.renamed.map(
      (r) =>
        `Renamed the ${r.kind} ${r.from} to ${r.to}, because the project already has one with that name.`,
    ),
    ...(g.moves.some((m) => m.gap)
      ? [
          `${g.moves
            .filter((m) => m.gap)
            .map((m) => m.app)
            .join(
              ', ',
            )} keep${g.moves.filter((m) => m.gap).length === 1 ? 's' : ''} data or a port, so ${g.moves.filter((m) => m.gap).length === 1 ? 'it restarts' : 'they restart'} while moving: briefly unavailable, data kept.`,
        ]
      : []),
  ];
  return project === null
    ? {
        kind: 'custom',
        compose: g.compose,
        values: g.values,
        adopt: g.adopt,
        notes,
      }
    : {
        kind: 'update',
        project,
        compose: g.compose,
        values: { ...g.running, ...runningValues, ...g.values },
        adopt: g.adopt,
        notes,
      };
}

/**
 * Moves apps that already run into a project: choose where (a new project, or one that exists), then the same review as
 * any compose update. Nothing is changed until that review is confirmed.
 */
export function GroupAppsDialog({
  apps,
  projects,
  pick,
  onClose,
}: {
  /** The apps to move (the ones to start with, when `pick` is set); null while closed */
  apps: string[] | null;
  /** The projects that exist. Left out, they are looked up when the dialog opens. */
  projects?: string[];
  /** Show the apps that are in no project, to tick the ones to move */
  pick?: boolean;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(NEW);
  const [mode, setMode] = useState<{
    project: string | null;
    mode: DeployMode;
  } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [movable, setMovable] = useState<
    { name: string; image: string }[] | null
  >(null);
  const [known, setKnown] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const open = apps !== null;
  const projectNames = projects ?? known;

  useEffect(() => {
    if (!open) return;
    setTarget(NEW);
    setChosen(apps ?? []);
    if (pick) {
      setMovable(null);
      void listMovableAppsAction().then((r) =>
        r.ok ? setMovable(r.data ?? []) : toast.error(r.error),
      );
    }
    if (!projects)
      void listProjectNamesAction().then((r) => r.ok && setKnown(r.data ?? []));
    // Looked up once per opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (mode)
    return (
      <DeployProjectDialog
        mode={mode.mode}
        existingProjects={projectNames}
        onClose={() => {
          setMode(null);
          onClose();
        }}
      />
    );

  const go = () =>
    startTransition(async () => {
      const project = target === NEW ? null : target;
      const res = await groupAppsAction(project, chosen);
      if (!res.ok || !res.data)
        return void toast.error(res.ok ? 'Nothing came back.' : res.error);
      setMode({ project, mode: modeFor(project, res.data) });
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {pick
              ? 'Move apps into a project'
              : `Move ${chosen.length === 1 ? chosen[0] : `${chosen.length} apps`} into a project`}
          </DialogTitle>
          <DialogDescription>
            They keep running and keep their data and addresses. You review
            exactly what happens before anything is touched.
          </DialogDescription>
        </DialogHeader>
        {pick ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">Apps</legend>
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {movable === null && (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
              {movable?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Every app is already part of a project.
                </p>
              )}
              {movable?.map((a) => (
                <label
                  key={a.name}
                  className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={chosen.includes(a.name)}
                    onCheckedChange={(c) =>
                      setChosen((cur) =>
                        c ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                      )
                    }
                  />
                  <span className="font-mono">{a.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {a.image}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          chosen.length > 1 && (
            <p className="font-mono text-xs text-muted-foreground">
              {chosen.join(', ')}
            </p>
          )
        )}
        <fieldset className="flex max-h-48 flex-col gap-2 overflow-y-auto">
          <legend className="mb-1 text-sm font-medium">Into</legend>
          {[NEW, ...projectNames].map((p) => (
            <label
              key={p || 'new'}
              className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary"
            >
              <input
                type="radio"
                name="target"
                checked={target === p}
                onChange={() => setTarget(p)}
              />
              {p === NEW ? (
                'A new project'
              ) : (
                <>
                  The project <span className="font-mono">{p}</span>
                </>
              )}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={go} disabled={pending || chosen.length === 0}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** On a project: choose among the apps that are not in one yet, and move them in. */
export function AddExistingAppsDialog({
  open,
  project,
  onClose,
  onGrouped,
}: {
  open: boolean;
  project: string;
  onClose: () => void;
  onGrouped: (g: GroupedApps) => void;
}) {
  const [list, setList] = useState<{ name: string; image: string }[] | null>(
    null,
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!open) return;
    setChosen([]);
    setList(null);
    void listMovableAppsAction().then((r) =>
      r.ok ? setList(r.data ?? []) : toast.error(r.error),
    );
  }, [open]);
  const go = () =>
    startTransition(async () => {
      const res = await groupAppsAction(project, chosen);
      if (!res.ok || !res.data)
        return void toast.error(res.ok ? 'Nothing came back.' : res.error);
      onGrouped(res.data);
    });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add apps that already run</DialogTitle>
          <DialogDescription>
            They join {project} with their data and addresses. You review what
            happens before anything is touched.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {list === null && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {list?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Every app is already part of a project.
            </p>
          )}
          {list?.map((a) => (
            <label
              key={a.name}
              className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <Checkbox
                checked={chosen.includes(a.name)}
                onCheckedChange={(c) =>
                  setChosen((cur) =>
                    c ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                  )
                }
              />
              <span className="font-mono">{a.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {a.image}
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={go} disabled={pending || chosen.length === 0}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
