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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatBytes, timeAgo } from '@/lib/format';
import { looksLikeDatabase } from '@/lib/volume-download';
import {
  IMPORTS_DEFAULT_DIR,
  canRestoreFromServer,
  filesOfKind,
  hostForHints,
  importError,
  restoreProblem,
  rsyncUpCommand,
  volumeRestoreFromUrl,
  type ImportsListing,
} from '@/lib/volume-import';
import { RestoreModeFields } from './restore-mode';

/**
 * Restores a volume from a .tar.gz that is already in the import folder on the server: put there with rsync or scp, or
 * saved by "Save a copy on the server" (on this server or another). Nothing is uploaded through the browser, so a file can
 * be as large as the disk, and the work goes on even if this page is closed. The dialog lists what the folder holds, says
 * how to put a file there, and asks the same questions as an upload.
 */
export function RestoreFromServer({
  open,
  onOpenChange,
  appName,
  volumeName,
  containerPath,
  image,
  running,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  volumeName: string;
  containerPath: string;
  image?: string;
  running: boolean;
}) {
  const router = useRouter();
  const [listing, setListing] = useState<ImportsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'empty' | 'replace'>('empty');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();
  const [host, setHost] = useState('<server>');
  const database = looksLikeDatabase(image);
  const replace = mode === 'replace';

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
      r.data && filesOfKind(r.data, 'volume').some((f) => f.name === cur)
        ? cur
        : '',
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    setHost(hostForHints(window.location.hostname));
    setSelected('');
    setMode('empty');
    setTyped('');
    setError(undefined);
    setDeleting(null);
    void refresh();
  }, [open, refresh]);

  // Only volume archives: a database dump in the folder is for a database, never for a volume
  const files = filesOfKind(listing, 'volume');
  const file = files.find((f) => f.name === selected) ?? null;
  const problem = file
    ? restoreProblem(file, listing?.freeBytes ?? null)
    : null;
  const dir = listing?.dir ?? IMPORTS_DEFAULT_DIR;
  const command = rsyncUpCommand(host, dir);
  const ready =
    canRestoreFromServer({ file, replace, typed, appName }) && !problem;

  const restore = async () => {
    if (!file || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(
        volumeRestoreFromUrl(
          appName,
          volumeName,
          file.name,
          replace ? { confirm: typed } : null,
        ),
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
          `Restored ${file.name} into ${volumeName}${running ? '. The app is starting again.' : ''}`,
        );
        onOpenChange(false);
        router.refresh();
      } else setError(importError(body, res.status, 'The restore'));
    } catch {
      setError(
        'Lost the connection to the console. The restore carries on at the server and the app is started again when it ends: look at the app before trying again.',
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
          <DialogTitle>
            Restore {volumeName} from a file on the server
          </DialogTitle>
          <DialogDescription>
            Into <span className="font-mono">{containerPath}</span> of {appName}
            . Nothing is uploaded through the browser, so the file can be as
            large as the disk.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 rounded-md border bg-secondary/30 p-3 text-xs">
          <p>
            Put the archive in <span className="font-mono">{dir}</span> on the
            server. From the machine that has the file:
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
            has another address. A copy saved on another server by &ldquo;Save a
            copy on the server&rdquo; can be pulled straight from there.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Files in the folder</span>
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
              Nothing in the folder yet. Put a file there, then refresh.
            </p>
          )}
          {listing && files.length > 0 && (
            <RadioGroup
              value={selected}
              onValueChange={setSelected}
              className="flex max-h-56 flex-col gap-1 overflow-y-auto"
              aria-label="File to restore"
              disabled={busy}
            >
              {files.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <RadioGroupItem value={f.name} disabled={!f.gzip} />
                    <span className="min-w-0">
                      <span className="block truncate font-mono">{f.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatBytes(f.sizeBytes)} · {timeAgo(f.modifiedAt)}
                        {f.gzip ? '' : ' · not a gzip archive'}
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
          {listing && listing.freeBytes !== null && (
            <p className="text-xs text-muted-foreground">
              Free space on the server: {formatBytes(listing.freeBytes)}.
            </p>
          )}
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>

        <RestoreModeFields
          appName={appName}
          volumeName={volumeName}
          mode={mode}
          onMode={setMode}
          typed={typed}
          onTyped={setTyped}
          busy={busy}
          halfWay="If the restore stops half way, the volume is left empty or partly written."
        />

        <p className="text-xs text-muted-foreground">
          {running
            ? `${appName} is stopped while the files are written and starts again by itself, even if the restore fails. It is unavailable meanwhile.`
            : `${appName} is stopped, and stays stopped.`}{' '}
          Owners and permissions of the files are kept. This can take several
          minutes for a large file, and carries on at the server if you close
          this page.
        </p>

        {database && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This looks like a database. Restoring its files only works if the
              copy was consistent (taken while it was stopped). A dump made with
              the database&apos;s own tool and loaded into a new database is
              safer.
            </p>
          </div>
        )}

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
