'use client';

import {
  Check,
  Download,
  HardDriveDownload,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
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
import { formatBytes } from '@/lib/format';
import { looksLikeDatabase, volumeDownloadUrl } from '@/lib/volume-download';
import {
  hostForHints,
  importError,
  rsyncDownCommand,
  volumeExportUrl,
  type ExportedCopy,
} from '@/lib/volume-import';

/**
 * Takes a volume's contents off the server as a .tar.gz: to this computer, or saved in the import folder on the server
 * (the way for anything large, and for moving data to another server with rsync). A live copy of a running database can
 * be inconsistent, so for what looks like one the dialog says so and starts from stopping the app while it is copied.
 */
export function DownloadVolume({
  appName,
  volumeName,
  containerPath,
  image,
  running,
  sizeBytes,
  disabled,
}: {
  appName: string;
  volumeName: string;
  containerPath: string;
  /** The image the app runs, to tell a database */
  image?: string;
  /** Whether the app is running now: stopping a stopped app means nothing */
  running: boolean;
  sizeBytes?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const database = looksLikeDatabase(image);
  const [how, setHow] = useState<'live' | 'stop'>(database ? 'stop' : 'live');
  const [where, setWhere] = useState<'browser' | 'server'>('browser');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ExportedCopy | null>(null);
  const [error, setError] = useState<string>();
  const [host, setHost] = useState('<server>');
  const stop = running && how === 'stop';

  const reset = () => {
    setHow(database && running ? 'stop' : 'live');
    setWhere('browser');
    setSaved(null);
    setError(undefined);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const res = await fetch(volumeExportUrl(appName, volumeName, stop), {
        method: 'POST',
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // not JSON: the message below says what it can
      }
      if (res.ok) setSaved(body as ExportedCopy);
      else setError(importError(body, res.status, 'Saving the copy'));
    } catch {
      setError(
        'Lost the connection to the console. The copy carries on at the server and the app is started again when it ends: look in the import folder before trying again.',
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
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          reset();
          setHost(hostForHints(window.location.hostname));
          setOpen(true);
        }}
      >
        <Download className="h-4 w-4" /> Download
      </Button>
      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Download {volumeName}</DialogTitle>
            <DialogDescription>
              Everything in <span className="font-mono">{containerPath}</span>{' '}
              of {appName}
              {sizeBytes !== undefined ? ` (${formatBytes(sizeBytes)})` : ''},
              as one .tar.gz file.
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
                ({formatBytes(saved.sizeBytes)})
                {saved.stopped ? '. The app has started again.' : '.'}
              </p>
              {saved.note && <p className="text-xs">{saved.note}</p>}
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
                choose <em>Restore → From a file on the server</em>. Replace{' '}
                <span className="font-mono">{host}</span> if the server has
                another address. Delete the file when you are done: it holds the
                data, secrets included.
              </p>
            </div>
          ) : (
            <>
              <RadioGroup
                value={where}
                onValueChange={(v) => setWhere(v as 'browser' | 'server')}
                className="flex flex-col gap-2"
                aria-label="Where to put the copy"
                disabled={saving}
              >
                {(
                  [
                    [
                      'browser',
                      'To this computer',
                      'The file comes through the browser. Fine for small volumes.',
                    ],
                    [
                      'server',
                      'Save a copy on the server',
                      'Written to the import folder on the server, with no size limit. Then fetch it with rsync or scp, or restore it on another server.',
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
                    <span className="text-xs text-muted-foreground">
                      {hint}
                    </span>
                  </label>
                ))}
              </RadioGroup>

              {running && (
                <RadioGroup
                  value={how}
                  onValueChange={(v) => setHow(v as 'live' | 'stop')}
                  className="flex flex-col gap-2"
                  aria-label="How to copy"
                  disabled={saving}
                >
                  {(
                    [
                      [
                        'live',
                        'Copy while it runs',
                        'The app keeps working. Files that change during the copy can end up out of step with each other.',
                      ],
                      [
                        'stop',
                        'Stop the app while copying',
                        where === 'server'
                          ? 'A consistent copy. The app is down until the copy is saved, and starts again by itself, even if it fails.'
                          : 'A consistent copy. The app is down until the download has finished, and starts again by itself, even if the download is cancelled.',
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
                      <span className="text-xs text-muted-foreground">
                        {hint}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              )}

              {database && how === 'live' && running && (
                <div
                  role="alert"
                  className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>
                    This looks like a database. A copy of the files of a
                    database that is running may not start, or may be missing
                    recent writes. Stop the app while copying, or take a dump
                    with the database&apos;s own tool.
                  </p>
                </div>
              )}
              {!running && (
                <p className="text-xs text-muted-foreground">
                  The app is stopped, so the copy is consistent.
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                The file holds the data as it is, secrets and passwords
                included: keep it as safe as the server.{' '}
                {where === 'server'
                  ? 'It is saved as a hidden file and only appears in the folder when it is complete. This can take several minutes for a large volume, and carries on at the server if you close this page.'
                  : `The download starts in a new tab${stop ? ', once the app has stopped' : ''}.`}{' '}
                Only volumes on the machine Provelox runs on can be copied.
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
            {!saved &&
              (where === 'browser' ? (
                <Button asChild>
                  <a
                    href={volumeDownloadUrl(appName, volumeName, stop)}
                    target="_blank"
                    rel="noopener"
                    onClick={() => setOpen(false)}
                  >
                    <Download className="h-4 w-4" /> Download
                  </a>
                </Button>
              ) : (
                <Button disabled={saving} onClick={() => void save()}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <HardDriveDownload className="h-4 w-4" />
                  )}{' '}
                  {saving ? 'Saving…' : 'Save a copy'}
                </Button>
              ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
