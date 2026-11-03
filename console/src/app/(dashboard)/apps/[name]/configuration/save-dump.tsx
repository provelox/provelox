'use client';

import { Check, HardDriveDownload, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  databaseExportUrl,
  ENGINE_LABEL,
  type DatabaseInfo,
  type SavedDump,
} from '@/lib/database-backup';
import { formatBytes } from '@/lib/format';
import {
  hostForHints,
  importError,
  rsyncDownCommand,
} from '@/lib/volume-import';

/**
 * Saves a dump of the database into the import folder on the server, with no size limit and no browser in between, so it
 * can be fetched with rsync or scp, or restored on another server. The dump is made by the database's own tool inside
 * the app's container; the app keeps running. The file only appears in the folder when the dump is whole.
 */
export function SaveDump({
  appName,
  engine,
  disabled,
}: {
  appName: string;
  engine: NonNullable<DatabaseInfo['engine']>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedDump | null>(null);
  const [error, setError] = useState<string>();
  const [host, setHost] = useState('<server>');

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetch(databaseExportUrl(appName, all), {
        method: 'POST',
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // not JSON: the message below says what it can
      }
      if (res.ok) setSaved(body as SavedDump);
      else setError(importError(body, res.status, 'Saving the backup'));
    } catch {
      setError(
        'Lost the connection to the console. The dump carries on at the server: look in the import folder before trying again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const command = saved ? rsyncDownCommand(host, saved.dir, saved.file) : '';

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setSaved(null);
          setError(undefined);
          setHost(hostForHints(window.location.hostname));
          setOpen(true);
        }}
      >
        <HardDriveDownload className="h-4 w-4" /> Save a backup on the server
      </Button>
      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Save a backup on the server</DialogTitle>
            <DialogDescription>
              A dump of the {ENGINE_LABEL[engine]} database of {appName},
              written to the import folder on the server. There is no size limit
              and nothing goes through the browser. {appName} keeps running.
            </DialogDescription>
          </DialogHeader>

          {saved ? (
            <div
              className="flex flex-col gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm"
              role="status"
            >
              <p className="flex items-center gap-2 font-medium">
                <Check className="h-4 w-4 text-emerald-600" /> Saved on the
                server
              </p>
              <p className="text-xs">
                <span className="font-mono break-all">
                  {saved.dir.replace(/\/+$/, '')}/{saved.file}
                </span>{' '}
                ({formatBytes(saved.sizeBytes)}).
              </p>
              <p className="text-xs text-muted-foreground">
                To fetch it to another machine, run this there:
              </p>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 font-mono text-xs">
                  {command}
                </code>
                <CopyButton value={command} />
              </div>
              <p className="text-xs text-muted-foreground">
                On a new server, put it in that server&apos;s import folder and
                choose <em>Restore → From a file on the server</em> on the
                database there. Replace{' '}
                <span className="font-mono">{host}</span> if the server has
                another address. Delete the file when you are done: it holds the
                data, passwords included.
              </p>
            </div>
          ) : (
            <>
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={all}
                  onCheckedChange={(c) => setAll(c === true)}
                  disabled={saving}
                />
                Every database on the server, not only this app&apos;s
              </label>
              <p className="text-xs text-muted-foreground">
                The file is a dump: consistent while the database runs, and the
                safe way to move a database. It holds the data as it is,
                passwords included: keep it as safe as the server. It is saved
                as a hidden file and only appears in the folder when the dump is
                complete. This can take several minutes for a large database,
                and carries on at the server if you close this page.
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              {saved ? 'Done' : 'Cancel'}
            </Button>
            {!saved && (
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <HardDriveDownload className="h-4 w-4" />
                )}{' '}
                {saving ? 'Saving…' : 'Save a backup'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
