'use client';

import {
  FolderInput,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { deleteImportAction, listImportsAction } from '@/actions/imports';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  canRestoreFromServer,
  databaseDumpUrl,
  databaseRestoreFromUrl,
  dumpProblem,
  ENGINE_LABEL,
  type DatabaseInfo,
} from '@/lib/database-backup';
import { formatBytes, timeAgo } from '@/lib/format';
import {
  filesOfKind,
  hostForHints,
  IMPORTS_DEFAULT_DIR,
  importError,
  rsyncUpCommand,
  type ImportsListing,
} from '@/lib/volume-import';

/**
 * Restores a database from a dump that is already in the import folder on the server: put there with rsync or scp, or
 * saved by "Save a backup on the server" (on this server or another). Nothing is uploaded through the browser, so a dump
 * can be as large as the disk, and the restore goes on even if this page is closed. The dialog lists the dumps the
 * folder holds (never the volume archives that may be beside them), says how to put one there, and asks the same
 * questions as an upload: add to what is there, or replace it, which needs the app's name typed.
 */
export function RestoreDumpFromServer({
  open,
  onOpenChange,
  appName,
  engine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  engine: NonNullable<DatabaseInfo['engine']>;
}) {
  const router = useRouter();
  const [listing, setListing] = useState<ImportsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [replace, setReplace] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();
  const [host, setHost] = useState('<server>');

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await listImportsAction();
    setLoading(false);
    if (!r.ok || !r.data) {
      setListing(null);
      setError(r.ok ? 'The folder could not be read.' : r.error);
      return;
    }
    setError(undefined);
    setListing(r.data);
    // a file that has gone is no longer chosen
    setSelected((cur) =>
      filesOfKind(r.data ?? null, 'database').some((f) => f.name === cur)
        ? cur
        : '',
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    setHost(hostForHints(window.location.hostname));
    setSelected('');
    setReplace(false);
    setTyped('');
    setError(undefined);
    setDeleting(null);
    void refresh();
  }, [open, refresh]);

  // Only dumps: a volume archive in the folder is for a volume, never for a database
  const files = filesOfKind(listing, 'database');
  const file = files.find((f) => f.name === selected) ?? null;
  const problem = file ? dumpProblem(file) : null;
  const dir = listing?.dir ?? IMPORTS_DEFAULT_DIR;
  const command = rsyncUpCommand(host, dir, './your-dump.dump');
  const ready =
    canRestoreFromServer({ file, replace, typed, appName }) && !problem;

  const restore = async () => {
    if (!file || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(
        databaseRestoreFromUrl(appName, file.name, replace),
        { method: 'POST' },
      );
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // not JSON: the message below says what it can
      }
      if (res.ok) {
        toast.success(
          replace
            ? `Replaced the database of ${appName} with ${file.name}`
            : `Restored ${file.name} into ${appName}`,
        );
        onOpenChange(false);
        router.refresh();
      } else setError(importError(body, res.status, 'The restore'));
    } catch {
      setError(
        'Lost the connection to the console. The restore carries on at the server: look at the database before trying again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = (name: string) =>
    startRemoving(async () => {
      const r = await deleteImportAction(name);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Deleted ${name} from the folder`);
      setDeleting(null);
      await refresh();
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore {appName} from a file on the server</DialogTitle>
          <DialogDescription>
            Into the {ENGINE_LABEL[engine]} database of {appName}. Nothing is
            uploaded through the browser, so the dump can be as large as the
            disk.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 rounded-md border bg-secondary/30 p-3 text-xs">
          <p>
            Put the dump (<span className="font-mono">.dump</span>,{' '}
            <span className="font-mono">.sql</span> or{' '}
            <span className="font-mono">.sql.gz</span>) in{' '}
            <span className="font-mono">{dir}</span> on the server. From the
            machine that has the file:
          </p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 font-mono">
              {command}
            </code>
            <CopyButton value={command} />
          </div>
          <p className="text-muted-foreground">
            rsync carries on where it stopped if the connection drops; scp does
            not. Replace <span className="font-mono">{host}</span> if the server
            has another address. A backup saved on another server by &ldquo;Save
            a backup on the server&rdquo; can be pulled straight from there.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Dumps in the folder</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refresh()}
              disabled={loading || busy}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}{' '}
              Refresh
            </Button>
          </div>
          {listing === null && loading && (
            <p className="text-sm text-muted-foreground">Looking…</p>
          )}
          {listing && files.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No dump in the folder yet. Put a file there, then refresh.
            </p>
          )}
          {listing && files.length > 0 && (
            <RadioGroup
              value={selected}
              onValueChange={setSelected}
              className="flex max-h-56 flex-col gap-1 overflow-y-auto"
              aria-label="Dump to restore"
              disabled={busy}
            >
              {files.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <RadioGroupItem
                      value={f.name}
                      disabled={f.sizeBytes === 0}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-mono">{f.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatBytes(f.sizeBytes)} · {timeAgo(f.modifiedAt)}
                        {f.sizeBytes === 0 ? ' · empty' : ''}
                      </span>
                    </span>
                  </label>
                  {deleting === f.name ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs">
                      Delete?
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={removing}
                        onClick={() => remove(f.name)}
                      >
                        {removing && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}{' '}
                        Delete
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={removing}
                        onClick={() => setDeleting(null)}
                      >
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      aria-label={`Delete ${f.name} from the folder`}
                      disabled={busy}
                      onClick={() => setDeleting(f.name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </RadioGroup>
          )}
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>

        <RadioGroup
          value={replace ? 'replace' : 'add'}
          onValueChange={(v) => setReplace(v === 'replace')}
          className="flex flex-col gap-2"
          aria-label="How to restore"
          disabled={busy}
        >
          {(
            [
              [
                'add',
                'Add to what is there',
                'The dump is applied on top of the database. It stops at the first thing that clashes with what exists, and says what that was.',
              ],
              [
                'replace',
                'Replace what is there',
                'Everything in the database is dropped first, then the dump is restored. This cannot be undone.',
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className="flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm has-[:checked]:border-primary"
            >
              <span className="flex items-center gap-2 font-medium">
                <RadioGroupItem value={value} />
                {label}
              </span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </label>
          ))}
        </RadioGroup>

        {replace && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm"
          >
            <p className="flex gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <span>
                This deletes everything in the database of <b>{appName}</b>.{' '}
                <a
                  href={databaseDumpUrl(appName, false)}
                  target="_blank"
                  rel="noopener"
                  className="underline underline-offset-2"
                >
                  Download a backup first
                </a>
                .
              </span>
            </p>
            <label className="flex flex-col gap-1 text-xs">
              Type <span className="font-mono">{appName}</span> to confirm
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-label={`Type ${appName} to confirm`}
              />
            </label>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          The app keeps running. While data is replaced its connections may see
          errors. A restore of a dump from a newer {ENGINE_LABEL[engine]} into
          an older one may not work. This can take several minutes for a large
          dump, and carries on at the server if you close this page.
        </p>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            variant={replace ? 'destructive' : 'default'}
            disabled={busy || !ready}
            onClick={() => void restore()}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderInput className="h-4 w-4" />
            )}{' '}
            {busy ? 'Restoring…' : replace ? 'Replace and restore' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
