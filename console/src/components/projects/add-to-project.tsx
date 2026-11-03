'use client';

import {
  ChevronDown,
  LayoutTemplate,
  Layers,
  Loader2,
  Plus,
  Server,
  Trash2,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  addServiceToProjectAction,
  addTemplateToProjectAction,
  listTemplatesAction,
  type GroupedApps,
  type MergedCompose,
} from '@/actions/projects';
import { AddExistingAppsDialog } from './group-apps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { Template } from '@/lib/types';

/** Turns what was renamed into sentences for the review that follows. */
export const notesOf = (m: MergedCompose) =>
  m.renamed.map(
    (r) =>
      `Renamed the ${r.kind} ${r.from} to ${r.to}, because the project already has one with that name.`,
  );

type Open = 'service' | 'template' | 'apps' | null;

/**
 * "Add" on a project: a service from a few fields, or the services of a template. Neither deploys anything: each makes a
 * new compose file, handed to `onMerged` to review and apply like any other update.
 */
export function AddToProject({
  project,
  existingServices,
  onMerged,
  onGrouped,
}: {
  project: string;
  /** The project's service names, to catch a clash before asking the server */
  existingServices: string[];
  onMerged: (m: MergedCompose) => void;
  /** Apps that already run were chosen: the compose file with them added, and which services they are */
  onGrouped: (g: GroupedApps) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // ?add=service or ?add=template (the command palette) opens that dialog
  const asked = useSearchParams().get('add');
  const [chosen, setChosen] = useState<Open | undefined>(undefined);
  useEffect(() => {
    if (asked) setChosen(undefined);
  }, [asked]);
  const fromAddress: Open =
    asked === 'service' || asked === 'template' ? asked : null;
  const open: Open = chosen === undefined ? fromAddress : chosen;
  const setOpen = (o: Open) => {
    setChosen(o);
    if (!o && asked) router.replace(pathname);
  };
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Plus className="h-4 w-4" /> Add <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            className="items-start gap-3 py-2"
            onSelect={() => setOpen('service')}
          >
            <Server className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block font-medium">Service</span>
              <span className="block text-xs text-muted-foreground">
                An image, with its port and variables.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="items-start gap-3 py-2"
            onSelect={() => setOpen('template')}
          >
            <LayoutTemplate className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block font-medium">From a template</span>
              <span className="block text-xs text-muted-foreground">
                A database or tool, next to what is here.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="items-start gap-3 py-2"
            onSelect={() => setOpen('apps')}
          >
            <Layers className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block font-medium">Apps that already run</span>
              <span className="block text-xs text-muted-foreground">
                Move them in, keeping their data.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddExistingAppsDialog
        project={project}
        open={open === 'apps'}
        onClose={() => setOpen(null)}
        onGrouped={(g) => {
          setOpen(null);
          onGrouped(g);
        }}
      />
      <ServiceDialog
        project={project}
        existing={existingServices}
        open={open === 'service'}
        onClose={() => setOpen(null)}
        onMerged={(m) => {
          setOpen(null);
          onMerged(m);
        }}
      />
      <TemplateDialog
        project={project}
        open={open === 'template'}
        onClose={() => setOpen(null)}
        onMerged={(m) => {
          setOpen(null);
          onMerged(m);
        }}
      />
    </>
  );
}

const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

function ServiceDialog({
  project,
  existing,
  open,
  onClose,
  onMerged,
}: {
  project: string;
  existing: string[];
  open: boolean;
  onClose: () => void;
  onMerged: (m: MergedCompose) => void;
}) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [port, setPort] = useState('');
  const [expose, setExpose] = useState(false);
  const [volumePath, setVolumePath] = useState('');
  const [env, setEnv] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setName('');
    setImage('');
    setPort('');
    setExpose(false);
    setVolumePath('');
    setEnv([]);
    setError(undefined);
  }, [open]);

  const nameProblem = !name
    ? null
    : !SERVICE_NAME.test(name)
      ? 'Use lowercase letters, numbers and dashes.'
      : existing.includes(name)
        ? 'The project already has a service with that name.'
        : null;
  const portNum = port ? Number(port) : undefined;
  const portProblem =
    port && !(Number.isInteger(portNum) && portNum! > 0 && portNum! < 65536)
      ? 'A port is a number from 1 to 65535.'
      : expose && !port
        ? 'Say which port to expose.'
        : null;
  const ok = !!name && !nameProblem && image.trim() !== '' && !portProblem;

  const submit = () =>
    startTransition(async () => {
      setError(undefined);
      const res = await addServiceToProjectAction(project, {
        name,
        image,
        port: portNum,
        expose,
        env,
        volumePath,
      });
      if (!res.ok || !res.data)
        return void setError(res.ok ? 'Nothing came back' : res.error);
      onMerged(res.data);
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a service to {project}</DialogTitle>
            <DialogDescription>
              It joins the project&apos;s private network, so the other services
              reach it by its name. You review the change before anything is
              deployed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Name</span>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value.trim().toLowerCase())}
                placeholder="e.g. api"
                className="font-mono"
                aria-invalid={!!nameProblem}
              />
              {nameProblem && (
                <span role="alert" className="text-xs text-destructive">
                  {nameProblem}
                </span>
              )}
              {!nameProblem && name && (
                <span className="text-xs text-muted-foreground">
                  The app is called{' '}
                  <code>
                    {project}-{name}
                  </code>
                  .
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Image</span>
              <Input
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="e.g. ghcr.io/acme/api:1.2"
                className="font-mono"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Port (optional)</span>
              <Input
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                placeholder="3000"
                aria-invalid={!!portProblem}
              />
              {portProblem && (
                <span role="alert" className="text-xs text-destructive">
                  {portProblem}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">
                Keep data at (optional)
              </span>
              <Input
                value={volumePath}
                onChange={(e) => setVolumePath(e.target.value)}
                placeholder="/data"
                className="font-mono"
              />
              <span className="text-xs text-muted-foreground">
                A volume that survives redeploys.
              </span>
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={expose}
              onCheckedChange={(v) => setExpose(v === true)}
              className="mt-0.5"
            />
            <span>
              Reachable from the internet
              <span className="block text-xs text-muted-foreground">
                Gives it a web address. Otherwise only the project&apos;s other
                services can call it.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Variables</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEnv((e) => [...e, { key: '', value: '' }])}
              >
                <Plus className="h-4 w-4" /> Add variable
              </Button>
            </div>
            {env.map((row, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={row.key}
                  onChange={(e) =>
                    setEnv((cur) =>
                      cur.map((r, j) =>
                        j === i ? { ...r, key: e.target.value.trim() } : r,
                      ),
                    )
                  }
                  placeholder="NAME"
                  aria-label="Variable name"
                  className="w-2/5 font-mono"
                />
                <Input
                  value={row.value}
                  onChange={(e) =>
                    setEnv((cur) =>
                      cur.map((r, j) =>
                        j === i ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder="value"
                  aria-label="Variable value"
                  className="flex-1 font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove variable"
                  onClick={() => setEnv((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {env.some((r) => /PASS|SECRET|TOKEN|KEY/i.test(r.key)) && (
              <p className="text-xs text-muted-foreground">
                Values for names like PASSWORD or TOKEN are kept out of the
                compose file and asked for again on each update.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ok || pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Continue
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDialog({
  project,
  open,
  onClose,
  onMerged,
}: {
  project: string;
  open: boolean;
  onClose: () => void;
  onMerged: (m: MergedCompose) => void;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!open || templates) return;
    void listTemplatesAction().then((res) =>
      res.ok ? setTemplates(res.data ?? []) : setError(res.error),
    );
  }, [open, templates]);
  useEffect(() => {
    if (open) {
      setQuery('');
      setError(undefined);
    }
  }, [open]);

  const shown = useMemo(
    () =>
      (templates ?? []).filter(
        (t) =>
          !query ||
          `${t.name} ${t.description} ${t.category} ${t.source?.name ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [templates, query],
  );

  const pick = (t: Template) => {
    setPicking(t.id);
    setError(undefined);
    startTransition(async () => {
      const res = await addTemplateToProjectAction(project, t.id);
      setPicking(null);
      if (!res.ok || !res.data) {
        toast.error(res.ok ? 'Nothing came back' : res.error);
        return void setError(res.ok ? undefined : res.error);
      }
      onMerged(res.data);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !picking && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a template to {project}</DialogTitle>
          <DialogDescription>
            Its services and volumes are added next to what is here. Anything
            that would clash with a name in the project is renamed. You review
            the change before anything is deployed.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates"
          aria-label="Search templates"
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {templates === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No template matches.</p>
        ) : (
          <ul className="flex max-h-96 flex-col divide-y overflow-y-auto rounded-md border">
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={picking !== null}
                  onClick={() => pick(t)}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-secondary/40 disabled:opacity-60"
                  aria-label={`Add ${t.name}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-medium">
                      {t.name} <Badge>{t.category}</Badge>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t.description}
                      {t.source && ` · from ${t.source.name}`}
                    </span>
                  </span>
                  {picking === t.id && (
                    <Loader2 className="mt-1 h-4 w-4 animate-spin" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
