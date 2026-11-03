'use client';

import {
  ChevronDown,
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
import { formatBytes } from '@/lib/format';
import {
  canRestore,
  looksLikeArchiveName,
  looksLikeDatabase,
  restoreError,
  volumeRestoreUrl,
} from '@/lib/volume-download';
import { uploadAdvice } from '@/lib/volume-import';
import { RestoreFromServer } from './restore-from-server';
import { RestoreModeFields } from './restore-mode';

/**
 * Puts a .tar.gz (one made by Download, say) into a volume, from a file on the server (the way for anything large) or
 * from this computer. By default only into an empty volume; replacing what is there needs the app's name typed, and the
 * dialog sends people to take a copy first. A browser upload is sent by a script so there is a real progress bar and a
 * Cancel that stops it (the server then starts the app again); it has to arrive within about a minute, so a big file is
 * warned about and a very big one is not offered.
 */
export function RestoreVolume({
  appName,
  volumeName,
  containerPath,
  image,
  running,
  disabled,
}: {
  appName: string;
  volumeName: string;
  containerPath: string;
  /** The image the app runs, to tell a database */
  image?: string;
  /** Whether the app is running now: it is stopped while data is written */
  running: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [mode, setMode] = useState<'empty' | 'replace'>('empty');
  const [typed, setTyped] = useState('');
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const database = looksLikeDatabase(image);
  const replace = mode === 'replace';
  const busy = sent !== null;
  const done = busy && file !== null && sent >= file.size;
  const advice = file ? uploadAdvice(file.size) : 'ok';

  const close = () => {
    if (busy) return;
    setFile(null);
    setMode('empty');
    setTyped('');
    setError(undefined);
  };

  const send = () => {
    if (
      !file ||
      advice === 'refuse' ||
      !canRestore({ file: true, replace, typed, appName })
    )
      return;
    setError(undefined);
    setSent(0);
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    xhr.open(
      'POST',
      volumeRestoreUrl(
        appName,
        volumeName,
        replace ? { confirm: typed } : null,
      ),
    );
    xhr.setRequestHeader('Content-Type', 'application/gzip');
    xhr.upload.onprogress = (e) => setSent(e.loaded);
    const finish = () => {
      request.current = null;
      setSent(null);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: the message below says what it can
      }
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        toast.success(
          `Restored ${file.name} into ${volumeName}${running ? '. The app is starting again.' : ''}`,
        );
        setFile(null);
        setTyped('');
        setMode('empty');
        router.refresh();
      } else setError(restoreError(body, xhr.status));
    };
    xhr.onerror = () => {
      finish();
      setError(
        'The upload was interrupted. The app is started again; if you were replacing, the volume may be partly written: restore a copy again.',
      );
    };
    xhr.onabort = () => {
      finish();
      setError(
        replace
          ? 'Cancelled. The volume had been emptied first and may be partly written: restore a copy of it again.'
          : 'Cancelled. The volume may be partly written.',
      );
    };
    xhr.send(file);
  };

  return (
    <>
      <input
        ref={picker}
        type="file"
        accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
        className="hidden"
        aria-label={`Archive to restore into ${volumeName}`}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (!f) return;
          if (!looksLikeArchiveName(f.name))
            return void toast.error(
              'Choose a .tar.gz or .tgz file, like the ones Download makes.',
            );
          setFile(f);
        }}
      />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" disabled={disabled}>
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
            onSelect={() => picker.current?.click()}
          >
            <Laptop className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block font-medium">From my computer</span>
              <span className="block text-xs text-muted-foreground">
                Uploads through the browser. Fine for small files.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RestoreFromServer
        open={serverOpen}
        onOpenChange={setServerOpen}
        appName={appName}
        volumeName={volumeName}
        containerPath={containerPath}
        image={image}
        running={running}
      />

      <Dialog open={file !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restore into {volumeName}</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{file?.name}</span>
              {file ? ` (${formatBytes(file.size)})` : ''} into{' '}
              <span className="font-mono">{containerPath}</span> of {appName}.
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

          <RestoreModeFields
            appName={appName}
            volumeName={volumeName}
            mode={mode}
            onMode={setMode}
            typed={typed}
            onTyped={setTyped}
            busy={busy}
            halfWay="If the upload stops half way, the volume is left empty or partly written."
          />

          <p className="text-xs text-muted-foreground">
            {running
              ? `${appName} is stopped while the data is written and starts again by itself, even if the upload fails or is cancelled. It is unavailable meanwhile.`
              : `${appName} is stopped, and stays stopped.`}{' '}
            Owners and permissions of the files are kept. Only volumes on the
            machine Provelox runs on can be restored.
          </p>

          {database && (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                This looks like a database. Restoring its files only works if
                the copy was consistent (taken while it was stopped). A dump
                made with the database&apos;s own tool and loaded into a new
                database is safer.
              </p>
            </div>
          )}

          {busy && file && (
            <div className="flex flex-col gap-1" aria-live="polite">
              <div
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(((sent ?? 0) / file.size) * 100)}
                className="h-2 overflow-hidden rounded-full bg-secondary"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.min(100, ((sent ?? 0) / file.size) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {done
                  ? 'Uploaded. Writing the files and starting the app again…'
                  : `${formatBytes(sent ?? 0)} of ${formatBytes(file.size)}`}
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            {busy ? (
              <Button
                variant="outline"
                onClick={() => request.current?.abort()}
              >
                Cancel upload
              </Button>
            ) : (
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
            )}
            <Button
              variant={replace ? 'destructive' : 'default'}
              disabled={
                busy ||
                advice === 'refuse' ||
                !canRestore({ file: !!file, replace, typed, appName })
              }
              onClick={send}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}{' '}
              {replace ? 'Replace and restore' : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
