'use client';

import { FolderOpen, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  getVolumeMigrationAction,
  loadMountSizesAction,
  startVolumeMigrationAction,
} from '@/actions/apps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type {
  AppDefinition,
  AppMount,
  DetectedMount,
  VolumeMigration,
} from '@/lib/types';
import { formatBytes } from '@/lib/format';
import { useUpdateApp } from '../use-update-app';
import { DownloadVolume } from './download-volume';
import { MigrationProgress } from './migration-progress';
import { RestoreVolume } from './restore-volume';

type Volume = AppDefinition['volumes'][number];

// Mounting these gives the container control over the whole server
const SENSITIVE = [
  '/',
  '/etc',
  '/root',
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/lib/docker',
];
const isSensitive = (p: string) =>
  SENSITIVE.includes(p.replace(/\/+$/, '') || '/');

const PATH_RE = /^\/[^\0:]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function StoragePanel({
  appName,
  mounts: initial,
  detected: initialDetected,
  migration: initialMigration,
  volumes,
  persistent,
  image,
  running,
}: {
  appName: string;
  /** The image the app runs: a download warns when it looks like a database */
  image?: string;
  running: boolean;
  mounts: AppMount[];
  detected: DetectedMount[];
  migration: VolumeMigration | null;
  volumes: Volume[];
  persistent: boolean;
}) {
  const { update, pending: saving } = useUpdateApp(appName);
  const [mounts, setMounts] = useState(initial);
  const [detected, setDetected] = useState(initialDetected);
  const addCardRef = useRef<HTMLDivElement>(null);

  // Moving unnamed data into a named volume
  const [migration, setMigration] = useState(initialMigration);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveName, setMoveName] = useState('');
  const [moveConfirmed, setMoveConfirmed] = useState(false);
  const [starting, startMoving] = useTransition();
  const migrating = migration?.status === 'running';

  function beginMove(d: DetectedMount) {
    setMoving(moving === d.containerPath ? null : d.containerPath);
    setMoveName(`${appName}-data`);
    setMoveConfirmed(false);
  }

  function startMove(d: DetectedMount) {
    startMoving(async () => {
      const res = await startVolumeMigrationAction(
        appName,
        d.containerPath,
        moveName,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setMoving(null);
      const state = await getVolumeMigrationAction(appName);
      if (state.ok && state.data) setMigration(state.data);
    });
  }
  const [sizing, startSizing] = useTransition();
  const [sized, setSized] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const [kind, setKind] = useState<'volume' | 'bind'>('volume');
  const [containerPath, setContainerPath] = useState('');
  const [source, setSource] = useState('');
  const [confirmSensitive, setConfirmSensitive] = useState(false);

  const sensitive = kind === 'bind' && isSensitive(source);
  const duplicate = volumes.some(
    (v) =>
      v.containerPath.replace(/\/+$/, '') === containerPath.replace(/\/+$/, ''),
  );
  const problem =
    containerPath && !PATH_RE.test(containerPath)
      ? 'The path inside the container must start with / (for example /var/lib/data)'
      : duplicate
        ? 'Something is already mounted at that path'
        : source && kind === 'volume' && !NAME_RE.test(source)
          ? 'Volume names use letters, numbers, dots, dashes and underscores'
          : source && kind === 'bind' && !PATH_RE.test(source)
            ? 'The directory on the server must start with /'
            : source.split('/').includes('..') ||
                containerPath.split('/').includes('..')
              ? 'Paths cannot contain ..'
              : null;
  const canAdd =
    persistent &&
    !!containerPath &&
    !!source &&
    !problem &&
    (!sensitive || confirmSensitive);

  function measure() {
    startSizing(async () => {
      const res = await loadMountSizesAction(appName);
      if (res.ok && res.data) {
        setMounts(res.data.mounts);
        setDetected(res.data.detected);
        setSized(true);
      } else if (!res.ok) toast.error(res.error);
    });
  }

  function add() {
    const entry: Volume =
      kind === 'volume'
        ? { containerPath, volumeName: source }
        : { containerPath, hostPath: source };
    update(
      { volumes: [...volumes, entry] },
      'Mount added. The app is restarting.',
    );
    setContainerPath('');
    setSource('');
    setConfirmSensitive(false);
  }

  return (
    <div className="flex flex-col gap-5">
      {migration && (
        <MigrationProgress
          key={migration.startedAt}
          appName={appName}
          initial={migration}
        />
      )}
      <Card>
        <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Mounted data</CardTitle>
            <CardDescription>
              Folders inside the container that are kept outside it, so the data
              survives restarts and deploys.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={sizing || mounts.every((m) => m.kind === 'bind')}
            onClick={measure}
          >
            {sizing && <Loader2 className="h-4 w-4 animate-spin" />}
            {sized ? 'Refresh sizes' : 'Show sizes'}
          </Button>
        </CardHeader>
        <CardContent className="divide-y">
          {mounts.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">
              {detected.length > 0
                ? 'Provelox is not managing any mount for this app. See the folders it is using anyway, below.'
                : 'Nothing is mounted. Files this app writes are lost when it restarts or is redeployed.'}
            </p>
          )}
          {mounts.map((m) => (
            <div key={m.containerPath} className="flex flex-col gap-2 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2">
                  {m.kind === 'volume' ? (
                    <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate font-mono text-sm">
                    {m.containerPath}
                  </span>
                  <Badge>
                    {m.kind === 'volume' ? 'Docker volume' : 'Server directory'}
                  </Badge>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {m.kind === 'volume' ? formatBytes(m.sizeBytes) : ''}
                  </span>
                  {m.kind === 'volume' && m.volumeName && (
                    <DownloadVolume
                      appName={appName}
                      volumeName={m.volumeName}
                      containerPath={m.containerPath}
                      image={image}
                      running={running}
                      sizeBytes={m.sizeBytes}
                      disabled={!m.created || migrating}
                    />
                  )}
                  {m.kind === 'volume' && m.volumeName && (
                    <RestoreVolume
                      appName={appName}
                      volumeName={m.volumeName}
                      containerPath={m.containerPath}
                      image={image}
                      running={running}
                      disabled={!m.created || migrating}
                    />
                  )}
                  {removing === m.containerPath ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={saving || migrating}
                        onClick={() => {
                          update(
                            {
                              volumes: volumes.filter(
                                (v) => v.containerPath !== m.containerPath,
                              ),
                            },
                            'Mount removed. The app is restarting.',
                          );
                          setMounts((cur) =>
                            cur.filter(
                              (x) => x.containerPath !== m.containerPath,
                            ),
                          );
                          setRemoving(null);
                        }}
                      >
                        Unmount now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemoving(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving || migrating}
                      onClick={() => setRemoving(m.containerPath)}
                    >
                      Unmount
                    </Button>
                  )}
                </div>
              </div>

              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
                {m.kind === 'volume' ? (
                  <>
                    <dt className="text-muted-foreground">Volume</dt>
                    <dd className="font-mono">{m.volumeName}</dd>
                    <dt className="text-muted-foreground">On the server</dt>
                    <dd className="flex items-center gap-2 font-mono">
                      {m.created ? (
                        <>
                          <span className="break-all">{m.mountpoint}</span>
                          {m.mountpoint && <CopyButton value={m.mountpoint} />}
                        </>
                      ) : (
                        <span className="font-sans text-muted-foreground">
                          Docker creates it the first time the app starts with
                          this mount.
                        </span>
                      )}
                    </dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted-foreground">On the server</dt>
                    <dd className="flex items-center gap-2 font-mono">
                      <span className="break-all">{m.hostPath}</span>
                      {m.hostPath && <CopyButton value={m.hostPath} />}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          ))}
          {mounts.length > 0 && (
            <p className="pt-3 text-xs text-muted-foreground">
              Unmounting only detaches the folder from the app: the data stays
              on the server, and mounting the same volume again brings it back.
            </p>
          )}
        </CardContent>
      </Card>

      {detected.length > 0 && (
        <Card
          className={
            detected.some((d) => d.anonymous)
              ? 'border-amber-500/50'
              : undefined
          }
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4" />
              In use, but not managed by Provelox
            </CardTitle>
            <CardDescription>
              These folders are mounted in the running container, but not
              through Provelox&apos;s settings. They are usually created by the
              image itself.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {detected.map((d) => {
              const target = `${appName}-data`;
              const location = d.mountpoint ?? d.hostPath;
              const copyCommand = d.volumeName
                ? `docker volume create ${target} && docker run --rm -v ${d.volumeName}:/from -v ${target}:/to alpine cp -a /from/. /to/`
                : '';
              return (
                <div key={d.containerPath} className="flex flex-col gap-3 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-sm">
                        {d.containerPath}
                      </span>
                      <Badge variant={d.anonymous ? 'warning' : 'default'}>
                        {d.anonymous
                          ? 'Unnamed volume'
                          : d.kind === 'volume'
                            ? 'Docker volume'
                            : 'Server directory'}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {d.kind === 'volume' ? formatBytes(d.sizeBytes) : ''}
                    </span>
                  </div>

                  <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">On the server</dt>
                    <dd className="flex items-center gap-2 font-mono">
                      <span className="break-all">{location}</span>
                      {location && <CopyButton value={location} />}
                    </dd>
                  </dl>

                  {d.anonymous && (
                    <div
                      role="alert"
                      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
                    >
                      <p className="text-sm font-medium">
                        This data is not kept when the app is redeployed.
                      </p>
                      <p className="text-muted-foreground">
                        The image asks Docker for a folder at{' '}
                        <code>{d.containerPath}</code>, and Docker gives every
                        new container a new, empty one. After the next deploy
                        the app starts with an empty folder, and the data shown
                        above stays behind on the server, unused. Mount a named
                        volume at this path to keep data from now on.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!persistent || migrating || !d.volumeName}
                          onClick={() => beginMove(d)}
                        >
                          Move to a named volume
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!persistent}
                          onClick={() => {
                            setKind('volume');
                            setContainerPath(d.containerPath);
                            setSource(target);
                            addCardRef.current?.scrollIntoView({
                              behavior: 'smooth',
                              block: 'center',
                            });
                          }}
                        >
                          Just fill in the form below
                        </Button>
                        {!persistent && (
                          <span className="text-muted-foreground">
                            This app was created without persistent data, see
                            the note below.
                          </span>
                        )}
                      </div>
                      {moving === d.containerPath && (
                        <div className="flex flex-col gap-3 rounded-md border bg-background p-3">
                          <p className="text-sm font-medium">
                            What will happen
                          </p>
                          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                            <li>
                              The app is <strong>stopped</strong>. It stays down
                              until the copy is done.
                            </li>
                            <li>
                              The data
                              {d.sizeBytes !== undefined
                                ? ` (${formatBytes(d.sizeBytes)})`
                                : ''}{' '}
                              is copied into a new volume and checked entry by
                              entry.
                            </li>
                            <li>
                              The app starts again with the new volume mounted
                              at <code>{d.containerPath}</code>.
                            </li>
                          </ol>
                          <p className="text-muted-foreground">
                            Your original data is{' '}
                            <strong>never changed or deleted</strong>. If
                            anything goes wrong before the switch, the new
                            volume is removed and the app starts again on its
                            original data.
                          </p>
                          <label className="flex flex-col gap-1">
                            <span className="font-medium">
                              Name of the new volume
                            </span>
                            <Input
                              value={moveName}
                              onChange={(e) => setMoveName(e.target.value)}
                              className="max-w-sm font-mono"
                              aria-label="Name of the new volume"
                              aria-invalid={
                                !!moveName && !NAME_RE.test(moveName)
                              }
                            />
                          </label>
                          {moveName && !NAME_RE.test(moveName) && (
                            <p role="alert" className="text-destructive">
                              Volume names use letters, numbers, dots, dashes
                              and underscores.
                            </p>
                          )}
                          <label className="flex items-start gap-2">
                            <Checkbox
                              className="mt-0.5"
                              checked={moveConfirmed}
                              onCheckedChange={(c) =>
                                setMoveConfirmed(c === true)
                              }
                            />
                            <span>
                              I understand that the app will be unavailable
                              while its data is copied.
                            </span>
                          </label>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={
                                starting ||
                                !moveConfirmed ||
                                !NAME_RE.test(moveName)
                              }
                              onClick={() => startMove(d)}
                            >
                              {starting && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              )}
                              Stop, copy and restart
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setMoving(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                      {copyCommand && (
                        <details className="text-muted-foreground">
                          <summary className="cursor-pointer text-foreground">
                            Keep the data that is already there
                          </summary>
                          <p className="mt-2">
                            1. On the server, copy the current data into the new
                            volume (this also creates it):
                          </p>
                          <div className="mt-1 flex items-start gap-2">
                            <code className="min-w-0 flex-1 break-all rounded-sm bg-muted p-2 font-mono text-[11px]">
                              {copyCommand}
                            </code>
                            <CopyButton value={copyCommand} />
                          </div>
                          <p className="mt-2">
                            2. For databases and file stores, set the app to 0
                            instances first (Overview) so nothing writes during
                            the copy.
                          </p>
                          <p className="mt-1">
                            3. Add the mount with the form below, then restore
                            the instance count.
                          </p>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div ref={addCardRef}>
        <Card>
          <CardHeader>
            <CardTitle>Add a mount</CardTitle>
            <CardDescription>Saving restarts the app.</CardDescription>
          </CardHeader>
          <CardContent>
            {!persistent && (
              <div
                role="note"
                className="mb-4 max-w-xl rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              >
                <p className="font-medium">
                  This app was created without &ldquo;persistent data&rdquo;.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Provelox only allows mounted data on apps created with that
                  option (they run a single instance and stay on one server),
                  and it can&apos;t be switched on afterwards. To use mounts,
                  create a new app with &ldquo;persistent data&rdquo; ticked,
                  then deploy to it.
                </p>
              </div>
            )}
            <form
              className={`flex max-w-xl flex-col gap-3 ${persistent ? '' : 'pointer-events-none opacity-50'}`}
              aria-disabled={!persistent}
              onSubmit={(e) => {
                e.preventDefault();
                if (canAdd) add();
              }}
            >
              <RadioGroup
                value={kind}
                onValueChange={(v) => {
                  setKind(v as 'volume' | 'bind');
                  setSource('');
                  setConfirmSensitive(false);
                }}
                className="flex flex-row gap-2"
                aria-label="Kind of mount"
              >
                {(
                  [
                    [
                      'volume',
                      'Docker volume',
                      'Managed by Docker. Recommended.',
                    ],
                    [
                      'bind',
                      'Server directory',
                      'A folder that already exists on the server.',
                    ],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={`flex flex-1 cursor-pointer flex-col rounded-md border p-3 text-sm ${kind === value ? 'border-primary' : 'border-input'}`}
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
              <Input
                value={containerPath}
                onChange={(e) => setContainerPath(e.target.value)}
                placeholder="Path inside the container, e.g. /var/lib/postgresql/data"
                aria-label="Path inside the container"
                className="font-mono"
              />
              <Input
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setConfirmSensitive(false);
                }}
                placeholder={
                  kind === 'volume'
                    ? 'Volume name, e.g. my-app-data'
                    : 'Directory on the server, e.g. /srv/my-app'
                }
                aria-label={
                  kind === 'volume' ? 'Volume name' : 'Directory on the server'
                }
                className="font-mono"
              />
              {kind === 'bind' && (
                <p className="flex gap-2 text-xs text-muted-foreground">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  The app gets read and write access to that directory on the
                  server. Only mount folders you trust it with.
                </p>
              )}
              {sensitive && (
                <label className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs">
                  <Checkbox
                    className="mt-0.5"
                    checked={confirmSensitive}
                    onCheckedChange={(c) => setConfirmSensitive(c === true)}
                  />
                  <span>
                    <strong>{source}</strong> gives this app control over the
                    whole server (it can read secrets, or start other
                    containers). I understand and want to mount it anyway.
                  </span>
                </label>
              )}
              {problem && (
                <p role="alert" className="text-xs text-destructive">
                  {problem}
                </p>
              )}
              <div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={saving || migrating || !canAdd}
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Add mount and restart
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
