'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  appReferencesAction,
  renameAppAction,
  type AppReference,
} from '@/actions/apps';
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
import { Input } from '@/components/ui/input';
import { explainAppName, isNewAppNameAllowed } from '@/lib/app-name';
import { renameFavorite } from '@/lib/use-favorites';

/**
 * Whether the rename dialog is open. It opens from the app's menu, or from ?rename=1 in the address (the command
 * palette); closing takes that off the address again.
 */
export function useRenameOpen() {
  const router = useRouter();
  const pathname = usePathname();
  const asked = useSearchParams().get('rename') === '1';
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (asked) setChosen(undefined);
  }, [asked]);
  const open = chosen === undefined ? asked : chosen;
  const setOpen = (o: boolean) => {
    setChosen(o);
    if (!o && asked) router.replace(pathname);
  };
  return [open, setOpen] as const;
}

export function RenameDialog({
  appName,
  existingApps,
  open,
  onOpenChange,
}: {
  appName: string;
  existingApps: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(appName);
  const [refs, setRefs] = useState<AppReference[] | null>(null);
  const [update, setUpdate] = useState(true);
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  // Who refers to this app is looked up each time the dialog opens: it may have changed since
  useEffect(() => {
    if (!open) return;
    setName(appName);
    setError(undefined);
    setUpdate(true);
    setKeep(false);
    setRefs(null);
    let current = true;
    void appReferencesAction(appName).then((res) => {
      if (current) setRefs(res.ok ? (res.data ?? []) : []);
    });
    return () => {
      current = false;
    };
  }, [open, appName]);

  const trimmed = name.trim();
  const taken = trimmed !== appName && existingApps.includes(trimmed);
  const problem = taken
    ? 'An app with that name already exists.'
    : trimmed === appName || trimmed === ''
      ? null
      : explainAppName(trimmed);
  const valid = trimmed !== appName && isNewAppNameAllowed(trimmed) && !taken;
  const editable = refs?.filter((r) => r.editable) ?? [];
  const locked = refs?.filter((r) => !r.editable) ?? [];

  const submit = () =>
    startTransition(async () => {
      const res = await renameAppAction(appName, trimmed, {
        updateReferences: update && editable.length > 0,
        keepOldName: keep,
      });
      if (!res.ok) return void setError(res.error);
      for (const f of res.data?.failed ?? [])
        toast.error(`${f.app} could not be updated: ${f.error}`);
      toast.success(
        res.data?.updated.length
          ? `Renamed to ${trimmed}; updated ${res.data.updated.join(', ')}`
          : `Renamed to ${trimmed}`,
      );
      renameFavorite(appName, trimmed);
      onOpenChange(false);
      router.replace(`/apps/${trimmed}`);
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {appName}</DialogTitle>
            <DialogDescription>
              The app restarts under its new name, so it is unavailable for a
              moment. Its data, secrets, domains and deploy keys stay with it.
              Its default address follows the name.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(undefined);
              }}
              aria-label="New name"
              aria-invalid={!!(problem || error)}
              disabled={pending}
            />
            {(problem || error) && (
              <p role="alert" className="text-xs text-destructive">
                {error ?? problem}
              </p>
            )}
          </div>

          {refs === null ? (
            <p className="text-sm text-muted-foreground">
              Checking which apps use this name…
            </p>
          ) : (
            <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
              {refs.length === 0 ? (
                <p className="text-muted-foreground">
                  No other app names {appName} in its variables.
                </p>
              ) : (
                <>
                  <p>
                    {refs.length === 1
                      ? '1 other app reaches'
                      : `${refs.length} other apps reach`}{' '}
                    <code>{appName}</code> by name:
                  </p>
                  <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {refs.map((r) => (
                      <li key={r.app}>
                        <span className="font-medium text-foreground">
                          {r.app}
                        </span>{' '}
                        in {r.keys.join(', ')}
                        {!r.editable && ' (part of a project: edit it there)'}
                      </li>
                    ))}
                  </ul>
                  {editable.length > 0 && (
                    <label className="flex items-start gap-2">
                      <Checkbox
                        checked={update}
                        onCheckedChange={(v) => setUpdate(v === true)}
                        className="mt-0.5"
                      />
                      <span>
                        Point them at the new name
                        <span className="block text-xs text-muted-foreground">
                          Changes those variables and restarts{' '}
                          {editable.length === 1
                            ? 'that app'
                            : `those ${editable.length} apps`}
                          .
                        </span>
                      </span>
                    </label>
                  )}
                </>
              )}
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={keep}
                  onCheckedChange={(v) => setKeep(v === true)}
                  className="mt-0.5"
                />
                <span>
                  Keep <code>{appName}</code> working as a second name
                  <span className="block text-xs text-muted-foreground">
                    Other apps can still reach it at the old name on the
                    network. Remove the alias later under Networking.
                    {locked.length > 0 &&
                      ' Recommended while a project still uses the old name.'}
                  </span>
                </span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !valid || refs === null}>
              {pending ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
