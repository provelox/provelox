'use client';

import { HardDrive, Layers, Loader2, Package, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteImagesAction,
  deleteVolumesAction,
  peekVolumeAction,
} from '@/actions/storage';
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
import { Combobox } from '@/components/ui/combobox';
import { formatBytes, formatDate } from '@/lib/format';
import type {
  DeleteResult,
  StorageImage,
  StorageReport,
  StorageVolume,
} from '@/lib/types';

const PAGE = 12;

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Reports what happened per item, so a refusal is never silent. */
function report(results: DeleteResult[], noun: string) {
  const removed = results.filter((r) => r.removed).length;
  const refused = results.filter((r) => !r.removed);
  if (removed)
    toast.success(`Removed ${removed} ${noun}${removed > 1 ? 's' : ''}`);
  for (const r of refused.slice(0, 3))
    toast.error(`${(r.name ?? r.id ?? '').slice(0, 24)}: ${r.reason}`);
  if (refused.length > 3)
    toast.error(`${refused.length - 3} more were refused`);
}

const short = (name: string) =>
  /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 12)}…` : name;

/** Unknown owner: look inside first, then type "delete". One at a time on purpose. */
function UnknownOwnerRow({
  title,
  detail,
  size,
  copyValue,
  onPeek,
  onRemove,
  pending,
  checked,
  onCheck,
}: {
  title: string;
  detail: string;
  size: string;
  copyValue: string;
  onPeek?: () => Promise<string | null>;
  onRemove: () => void;
  pending: boolean;
  checked: boolean;
  onCheck: () => void;
}) {
  const [listing, setListing] = useState<string | null>(null);
  const [peeking, startPeek] = useTransition();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={onCheck}
          aria-label={`Select ${title}`}
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-mono text-sm">
            <span className="truncate">{title}</span>
            <CopyButton value={copyValue} label="Copy" />
          </p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{size}</span>
          {onPeek && (
            <Button
              size="sm"
              variant="outline"
              disabled={peeking}
              onClick={() =>
                listing !== null
                  ? setListing(null)
                  : startPeek(async () => setListing(await onPeek()))
              }
            >
              {peeking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {listing !== null ? 'Hide' : 'Look inside'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setOpen((o) => !o)}
          >
            Remove…
          </Button>
        </div>
      </div>
      {listing !== null && (
        <pre className="max-h-48 overflow-auto rounded-sm bg-muted p-2 font-mono text-xs">
          {listing || '(empty)'}
        </pre>
      )}
      {open && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim().toLowerCase() === 'delete') onRemove();
          }}
        >
          <span className="basis-full">
            Provelox cannot tell who owns this, so it cannot be sure nothing
            needs it. Deleting is permanent. Type <strong>delete</strong> to
            confirm.
          </span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type delete to confirm"
            placeholder="delete"
            className="h-8 w-32"
          />
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={pending || typed.trim().toLowerCase() !== 'delete'}
          >
            Remove permanently
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * Removing several things whose owner Provelox cannot prove. The friction is deliberate: it lists what goes, says
 * what could go wrong, and wants the number typed, so a stray click cannot clear a list.
 */
function BulkRemove({
  noun,
  names,
  total,
  bytes,
  sharedLayers,
  pending,
  onSelectAll,
  onClear,
  onRemove,
}: {
  noun: 'image' | 'volume';
  names: string[];
  total: number;
  bytes: number;
  sharedLayers: boolean;
  pending: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const count = names.length;
  const plural = (n: number) => `${noun}${n === 1 ? '' : 's'}`;
  const ready = typed.trim() === String(count);

  if (count === 0)
    return (
      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" variant="ghost" onClick={onSelectAll}>
          Select all {total}
        </Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setTyped('');
            setOpen((o) => !o);
          }}
        >
          Remove {count} selected…
        </Button>
        {count < total && (
          <Button size="sm" variant="ghost" onClick={onSelectAll}>
            Select all {total}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            onClear();
          }}
        >
          Clear selection
        </Button>
        <span className="text-xs text-muted-foreground">
          {sharedLayers ? 'up to ' : ''}
          {formatBytes(bytes)}
        </span>
      </div>
      {open && (
        <form
          className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) onRemove();
          }}
        >
          <p>
            <strong>
              Remove {count} {plural(count)} permanently?
            </strong>{' '}
            Provelox cannot tell who owns these. Something else on this server
            (another platform, a container you run by hand) might expect them to
            be there, and {noun === 'volume' ? 'data in a volume' : 'an image'}{' '}
            that is removed cannot be brought back
            {noun === 'image' ? ' except by pulling or building it again' : ''}.
            {sharedLayers
              ? ' Sizes include layers other images share, so less space may be freed.'
              : ''}{' '}
            {noun === 'image'
              ? 'Docker refuses an image a container is using, and that one is skipped.'
              : 'A volume a container is using is refused and skipped.'}
          </p>
          <ul className="max-h-32 overflow-auto rounded-sm bg-background/60 p-2 font-mono">
            {names.slice(0, 10).map((n) => (
              <li key={n} className="truncate">
                {n}
              </li>
            ))}
            {count > 10 && <li>and {count - 10} more</li>}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`confirm-${noun}`}>
              Type <strong>{count}</strong> to confirm
            </label>
            <Input
              id={`confirm-${noun}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={String(count)}
              inputMode="numeric"
              className="h-8 w-24"
            />
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={pending || !ready}
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Remove {count} {plural(count)}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export function StoragePanel({ report: data }: { report: StorageReport }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pickedVolumes, setPickedVolumes] = useState<Set<string>>(new Set());
  const [pickedImages, setPickedImages] = useState<Set<string>>(new Set());
  const [pickedUnknownVolumes, setPickedUnknownVolumes] = useState<Set<string>>(
    new Set(),
  );
  const [pickedUnknownImages, setPickedUnknownImages] = useState<Set<string>>(
    new Set(),
  );
  const [confirm, setConfirm] = useState<'volumes' | 'images' | null>(null);
  const [volLimit, setVolLimit] = useState(PAGE);
  const [imgLimit, setImgLimit] = useState(PAGE);

  const volumes = (rule: StorageVolume['delete']) =>
    data.volumes.filter((v) => v.delete === rule);
  const images = (rule: StorageImage['delete']) =>
    data.images.filter((i) => i.delete === rule);
  const ownVolumes = volumes('yes');
  const unknownVolumes = volumes('acknowledge').sort(
    (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
  );
  const protectedVolumes = volumes('no');
  const oldImages = images('yes');
  const unknownImages = images('acknowledge').sort(
    (a, b) => b.sizeBytes - a.sizeBytes,
  );
  const protectedImages = images('no');

  const toggle = (
    set: Set<string>,
    setSet: (s: Set<string>) => void,
    key: string,
  ) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSet(next);
  };

  function removeVolumes(names: string[], acknowledge: boolean) {
    startTransition(async () => {
      const res = await deleteVolumesAction(names, acknowledge);
      if (!res.ok) toast.error(res.error);
      else report(res.data ?? [], 'volume');
      setPickedVolumes(new Set());
      setPickedUnknownVolumes(new Set());
      setConfirm(null);
      router.refresh();
    });
  }

  function removeImages(ids: string[], acknowledge: boolean) {
    startTransition(async () => {
      const res = await deleteImagesAction(ids, data.keepVersions, acknowledge);
      if (!res.ok) toast.error(res.error);
      else report(res.data ?? [], 'image');
      setPickedImages(new Set());
      setPickedUnknownImages(new Set());
      setConfirm(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Images"
          value={formatBytes(data.totals.imagesBytes)}
          hint="Layers shared between images are counted once"
        />
        <Stat
          label="Volumes"
          value={formatBytes(data.totals.volumesBytes)}
          hint={`${data.volumes.length} volumes`}
        />
        <Stat
          label="Containers"
          value={String(data.totals.containers)}
          hint="Running and stopped"
        />
        <Stat
          label="Build cache"
          value={formatBytes(data.totals.buildCacheBytes)}
          hint={`${formatBytes(data.totals.buildCacheReclaimableBytes)} reclaimable`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> Volumes that nothing uses
          </CardTitle>
          <CardDescription>
            This Docker host may run things besides Provelox, so a volume is
            only offered for removal without question when Provelox can show
            that it created it. Volumes in use, or mounted by an app, can never
            be removed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <section>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              Left behind by Provelox{' '}
              <Badge variant="success">safe to remove</Badge>
            </h3>
            {ownVolumes.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                Nothing. Originals left after moving an app&apos;s data show up
                here.
              </p>
            ) : (
              <>
                <div className="divide-y">
                  {ownVolumes.map((v) => (
                    <label
                      key={v.name}
                      className="flex cursor-pointer items-center gap-3 py-2"
                    >
                      <Checkbox
                        checked={pickedVolumes.has(v.name)}
                        onCheckedChange={() =>
                          toggle(pickedVolumes, setPickedVolumes, v.name)
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm">
                          {short(v.name)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {v.reason}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(v.sizeBytes)}{' '}
                        {formatDate(v.createdAt) &&
                          `· ${formatDate(v.createdAt)}`}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  {confirm === 'volumes' ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => removeVolumes([...pickedVolumes], false)}
                      >
                        {pending && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        Remove {pickedVolumes.size} now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pickedVolumes.size === 0}
                        onClick={() => setConfirm('volumes')}
                      >
                        Remove selected ({pickedVolumes.size})
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPickedVolumes(
                            new Set(ownVolumes.map((v) => v.name)),
                          )
                        }
                      >
                        Select all
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              Owner unknown{' '}
              <Badge variant="warning">check before removing</Badge>
              <span className="text-xs font-normal text-muted-foreground">
                {unknownVolumes.length} ·{' '}
                {formatBytes(data.reclaimable.volumes.needsAck)}
              </span>
            </h3>
            <p className="text-xs text-muted-foreground">
              No container uses these and no Provelox app mounts them, but
              Provelox did not create them, so they may be old databases or
              someone else&apos;s data. Use &ldquo;Look inside&rdquo; to see
              what they hold. Largest first.
            </p>
            {unknownVolumes.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">None.</p>
            ) : (
              <div className="divide-y">
                {unknownVolumes.slice(0, volLimit).map((v) => (
                  <UnknownOwnerRow
                    key={v.name}
                    title={short(v.name)}
                    detail={`${v.kind === 'unnamed-orphan' ? 'Unnamed volume' : 'Named volume'}${formatDate(v.createdAt) ? ` · created ${formatDate(v.createdAt)}` : ''}`}
                    size={formatBytes(v.sizeBytes)}
                    copyValue={v.name}
                    pending={pending}
                    onPeek={async () => {
                      const res = await peekVolumeAction(v.name);
                      if (res.ok) return res.data ?? '';
                      toast.error(res.error);
                      return null;
                    }}
                    onRemove={() => removeVolumes([v.name], true)}
                    checked={pickedUnknownVolumes.has(v.name)}
                    onCheck={() =>
                      toggle(
                        pickedUnknownVolumes,
                        setPickedUnknownVolumes,
                        v.name,
                      )
                    }
                  />
                ))}
              </div>
            )}
            {unknownVolumes.length > 1 && (
              <BulkRemove
                noun="volume"
                names={[...pickedUnknownVolumes].map(short)}
                total={unknownVolumes.length}
                bytes={unknownVolumes
                  .filter((v) => pickedUnknownVolumes.has(v.name))
                  .reduce((n, v) => n + (v.sizeBytes ?? 0), 0)}
                sharedLayers={false}
                pending={pending}
                onSelectAll={() =>
                  setPickedUnknownVolumes(
                    new Set(unknownVolumes.map((v) => v.name)),
                  )
                }
                onClear={() => setPickedUnknownVolumes(new Set())}
                onRemove={() => removeVolumes([...pickedUnknownVolumes], true)}
              />
            )}
            {unknownVolumes.length > volLimit && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVolLimit((l) => l + PAGE * 4)}
              >
                Show more ({unknownVolumes.length - volLimit} left)
              </Button>
            )}
          </section>

          {protectedVolumes.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {protectedVolumes.length} volume
                {protectedVolumes.length > 1 ? 's' : ''} in use or mounted by an
                app (cannot be removed)
              </summary>
              <ul className="mt-2 divide-y text-xs">
                {protectedVolumes.map((v) => (
                  <li
                    key={v.name}
                    className="flex justify-between gap-3 py-1.5"
                  >
                    <span className="truncate font-mono">{short(v.name)}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {v.usedBy.length
                        ? `used by ${v.usedBy[0].service ?? v.usedBy[0].container}`
                        : v.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" /> Images
          </CardTitle>
          <CardDescription>
            Every deploy leaves its image on the server. Old versions of your
            apps are Provelox&apos;s to clean up. Other unused images may belong
            to something else.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Keep the running version and the
            <Combobox
              value={String(data.keepVersions)}
              onValueChange={(v) =>
                router.push(`/settings/infrastructure?keep=${v}#storage`)
              }
              size="sm"
              className="w-[4.5rem]"
              aria-label="Versions to keep"
              options={[0, 1, 2, 3, 5, 10].map((n) => ({
                value: String(n),
                label: String(n),
              }))}
            />
            before it, for rolling back.
          </div>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              Old versions of your apps{' '}
              <Badge variant="success">safe to remove</Badge>
              <span className="text-xs font-normal text-muted-foreground">
                {oldImages.length} · up to{' '}
                {formatBytes(data.reclaimable.images.provable)}
              </span>
            </h3>
            {oldImages.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                Nothing to clean up with this setting.
              </p>
            ) : (
              <>
                <div className="divide-y">
                  {oldImages.slice(0, imgLimit).map((i) => (
                    <label
                      key={i.id}
                      className="flex cursor-pointer items-center gap-3 py-2"
                    >
                      <Checkbox
                        checked={pickedImages.has(i.id)}
                        onCheckedChange={() =>
                          toggle(pickedImages, setPickedImages, i.id)
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm">
                          {i.tags[0] ?? i.id.slice(7, 19)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {i.app} version {i.version}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(i.sizeBytes)}
                      </span>
                    </label>
                  ))}
                </div>
                {oldImages.length > imgLimit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setImgLimit((l) => l + PAGE * 4)}
                  >
                    Show more ({oldImages.length - imgLimit} left)
                  </Button>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  {confirm === 'images' ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => removeImages([...pickedImages], false)}
                      >
                        {pending && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        Remove {pickedImages.size} now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pickedImages.size === 0}
                        onClick={() => setConfirm('images')}
                      >
                        Remove selected ({pickedImages.size})
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPickedImages(new Set(oldImages.map((i) => i.id)))
                        }
                      >
                        Select all
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              Unused, owner unknown{' '}
              <Badge variant="warning">check before removing</Badge>
              <span className="text-xs font-normal text-muted-foreground">
                {unknownImages.length}
              </span>
            </h3>
            <p className="text-xs text-muted-foreground">
              No app deploys these and no container uses them, but they are not
              Provelox&apos;s to judge. Sizes include layers that other images
              share, so removing them frees less than the sum.
            </p>
            {unknownImages.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">None.</p>
            ) : (
              <div className="divide-y">
                {unknownImages.slice(0, imgLimit).map((i) => (
                  <UnknownOwnerRow
                    key={i.id}
                    title={i.tags[0] ?? `untagged ${i.id.slice(7, 19)}`}
                    detail={`${i.tags.length > 1 ? `${i.tags.length} tags · ` : ''}${i.reason}`}
                    size={formatBytes(i.sizeBytes)}
                    copyValue={i.tags[0] ?? i.id}
                    pending={pending}
                    onRemove={() => removeImages([i.id], true)}
                    checked={pickedUnknownImages.has(i.id)}
                    onCheck={() =>
                      toggle(pickedUnknownImages, setPickedUnknownImages, i.id)
                    }
                  />
                ))}
              </div>
            )}
            {unknownImages.length > 1 && (
              <BulkRemove
                noun="image"
                names={unknownImages
                  .filter((i) => pickedUnknownImages.has(i.id))
                  .map((i) => i.tags[0] ?? `untagged ${i.id.slice(7, 19)}`)}
                total={unknownImages.length}
                bytes={unknownImages
                  .filter((i) => pickedUnknownImages.has(i.id))
                  .reduce((n, i) => n + i.sizeBytes, 0)}
                sharedLayers
                pending={pending}
                onSelectAll={() =>
                  setPickedUnknownImages(
                    new Set(unknownImages.map((i) => i.id)),
                  )
                }
                onClear={() => setPickedUnknownImages(new Set())}
                onRemove={() => removeImages([...pickedUnknownImages], true)}
              />
            )}
            {unknownImages.length > imgLimit && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setImgLimit((l) => l + PAGE * 4)}
              >
                Show more ({unknownImages.length - imgLimit} left)
              </Button>
            )}
          </section>

          {protectedImages.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {protectedImages.length} image
                {protectedImages.length > 1 ? 's' : ''} in use, kept for
                rollback, or needed by Provelox
              </summary>
              <ul className="mt-2 divide-y text-xs">
                {protectedImages.map((i) => (
                  <li key={i.id} className="flex justify-between gap-3 py-1.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <Package className="h-3 w-3 shrink-0" />
                      <span className="truncate font-mono">
                        {i.tags[0] ?? i.id.slice(7, 19)}
                      </span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {i.kind === 'in-use'
                        ? 'in use'
                        : i.kind === 'system'
                          ? 'needed by Provelox'
                          : `kept: ${i.app} v${i.version}`}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
