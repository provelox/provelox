'use client';

import {
  ChevronDown,
  Database,
  Download,
  FolderInput,
  Laptop,
  Loader2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  canRestore,
  databaseDumpUrl,
  databaseRestoreUrl,
  DUMP_ACCEPT,
  ENGINE_LABEL,
  uploadDump,
  type DatabaseInfo,
} from '@/lib/database-backup';
import { formatBytes } from '@/lib/format';
import { uploadAdvice } from '@/lib/volume-import';
import { RestoreDumpFromServer } from './restore-dump-from-server';
import { SaveDump } from './save-dump';

/**
 * Backs up and restores the database an app runs, with the database's own tools (run inside its container, where its
 * credentials already are). The app keeps running. Shown only for an app Provelox could look into and recognise.
 */
export function DatabasePanel({
  appName,
  info,
}: {
  appName: string;
  info: DatabaseInfo;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [all, setAll] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [typed, setTyped] = useState('');
  const [sent, setSent] = useState<{ sent: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string>();
  const [serverOpen, setServerOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const busy = sent !== null;
  const advice = file ? uploadAdvice(file.size) : 'ok';

  if (!info.engine) return null;
  const engine = ENGINE_LABEL[info.engine];

  const close = () => {
    if (busy) return;
    setFile(null);
    setReplace(false);
    setTyped('');
    setError(undefined);
  };

  const restore = async () => {
    if (!file) return;
    setError(undefined);
    setSent({ sent: 0, total: file.size });
    abort.current = new AbortController();
    try {
      await uploadDump(
        databaseRestoreUrl(appName, replace),
        file,
        (s, t) => setSent({ sent: s, total: t }),
        abort.current.signal,
      );
      toast.success(
        replace
          ? `Replaced the database of ${appName} with ${file.name}`
          : `Restored ${file.name} into ${appName}`,
      );
      setSent(null);
      close();
      router.refresh();
    } catch (e) {
      setSent(null);
      if (e instanceof DOMException && e.name === 'AbortError')
        setError('Cancelled. What was restored before that stays.');
      else setError(e instanceof Error ? e.message : 'The restore failed.');
    }
  };

  const percent = sent
    ? Math.min(100, Math.round((sent.sent / Math.max(1, sent.total)) * 100))
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4" /> Database
        </CardTitle>
        <CardDescription>
          {engine} · back up and restore with the database&apos;s own tools. The
          app keeps running.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!info.canBackup ? (
          <p className="text-sm text-muted-foreground">
            {info.reason ?? 'Provelox cannot back this database up from here.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="sm" variant="outline">
                <a
                  href={databaseDumpUrl(appName, all)}
                  target="_blank"
                  rel="noopener"
                >
                  <Download className="h-4 w-4" /> Download backup
                </a>
              </Button>
              <SaveDump appName={appName} engine={info.engine} />
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Upload className="h-4 w-4" /> Restore
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuItem
                    className="items-start gap-3 py-2"
                    onSelect={() => setServerOpen(true)}
                  >
                    <FolderInput className="mt-0.5 h-4 w-4" />
                    <span>
                      <span className="block font-medium">
                        From a file on the server
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        For anything large: put it there with rsync or scp.
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="items-start gap-3 py-2"
                    onSelect={() => input.current?.click()}
                  >
                    <Laptop className="mt-0.5 h-4 w-4" />
                    <span>
                      <span className="block font-medium">
                        From my computer
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Uploads through the browser. Fine for small files.
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                ref={input}
                type="file"
                accept={DUMP_ACCEPT}
                className="sr-only"
                aria-label="Choose a backup file to restore"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  if (f) {
                    setFile(f);
                    setError(undefined);
                  }
                }}
              />
            </div>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={all}
                onCheckedChange={(c) => setAll(c === true)}
              />
              Every database on the server, not only this app&apos;s
            </label>
            <p className="text-xs text-muted-foreground">
              A backup made this way is a dump: the safe way to move a database
              or keep a copy, because it is consistent while the database runs.
              It holds the data as it is, passwords included: keep it as safe as
              the server.
            </p>
          </>
        )}
      </CardContent>

      <Dialog open={file !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restore into {appName}</DialogTitle>
            <DialogDescription>
              {file ? (
                <>
                  <span className="font-mono">{file.name}</span> (
                  {formatBytes(file.size)}) into the {engine} database of{' '}
                  {appName}.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {advice !== 'ok' && file && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            >
              <p className="flex gap-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {advice === 'refuse'
                    ? `This file is ${formatBytes(file.size)}, too large to upload through the browser.`
                    : `This file is ${formatBytes(file.size)}. An upload through the browser has to arrive within about a minute, or the proxy cuts it, and a slow connection will not manage that.`}{' '}
                  Put it on the server with rsync or scp and restore from there:
                  that has no size limit and carries on if the connection drops.
                </span>
              </p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setFile(null);
                    setServerOpen(true);
                  }}
                >
                  <FolderInput className="h-4 w-4" /> Use a file on the server
                </Button>
              </div>
            </div>
          )}

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
            The app keeps running. While data is replaced its connections may
            see errors. A restore of a dump from a newer {engine} into an older
            one may not work.
          </p>

          {busy && (
            <div className="flex flex-col gap-1">
              <div
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 overflow-hidden rounded-full bg-secondary"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {percent < 100
                  ? `Sending… ${percent}% (${formatBytes(sent?.sent ?? 0)} of ${formatBytes(sent?.total ?? 0)})`
                  : 'Sent. The database is restoring it, this can take a while…'}
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
              onClick={() => (busy ? abort.current?.abort() : close())}
            >
              {busy ? 'Cancel upload' : 'Close'}
            </Button>
            <Button
              variant={replace ? 'destructive' : 'default'}
              disabled={
                advice === 'refuse' ||
                !canRestore({ file, replace, typed, appName, busy })
              }
              onClick={restore}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {replace ? 'Replace and restore' : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RestoreDumpFromServer
        open={serverOpen}
        onOpenChange={setServerOpen}
        appName={appName}
        engine={info.engine}
      />
    </Card>
  );
}
