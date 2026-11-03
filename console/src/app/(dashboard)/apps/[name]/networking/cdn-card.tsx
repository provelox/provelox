'use client';

import { Cloud, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  refreshCdnAction,
  removeCdnProviderAction,
  saveCdnProviderAction,
} from '@/actions/cdn';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { rangesSummary, type CdnProvider } from '@/lib/cdn';
import { useUpdateApp } from '../use-update-app';

const NEW = '__new__';

/**
 * Tells Provelox a CDN sits in front of the app. The proxy then trusts the CDN's X-Forwarded-For, so the app can see
 * its visitors' addresses instead of the CDN's, and can refuse anyone who reaches the server around the CDN.
 */
export function CdnCard({
  appName,
  initial,
  providers: initialProviders,
}: {
  appName: string;
  initial?: { provider: string; enforce: boolean };
  providers: CdnProvider[];
}) {
  const { update, pending } = useUpdateApp(appName);
  const [providers, setProviders] = useState(initialProviders);
  const [on, setOn] = useState(!!initial);
  const [id, setId] = useState(initial?.provider ?? 'cloudfront');
  const [enforce, setEnforce] = useState(initial?.enforce ?? false);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [refreshing, startRefresh] = useTransition();

  const current = providers.find((p) => p.id === id);
  const dirty =
    on !== !!initial ||
    (on && (id !== initial?.provider || enforce !== initial?.enforce));

  function save() {
    if (!on) return update({ cdn: null }, 'No longer behind a CDN.');
    update(
      { cdn: { provider: id, enforce } },
      enforce
        ? 'Saved. Only requests from the CDN reach the app.'
        : 'Saved. The proxy now trusts the CDN’s forwarded address.',
    );
  }

  function refresh() {
    startRefresh(async () => {
      const r = await refreshCdnAction();
      if (r.ok) {
        setProviders(r.data ?? providers);
        toast.success('Address ranges refreshed.');
      } else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4" aria-hidden="true" /> Behind a CDN
          </CardTitle>
          <CardDescription>
            When a CDN such as CloudFront or Cloudflare sits in front of this
            app, every visitor reaches the server from the CDN’s address. Say
            which one, and the proxy keeps the visitor’s address so the app can
            read it, and can refuse requests that skip the CDN.
          </CardDescription>
        </div>
        <Switch
          checked={on}
          onCheckedChange={setOn}
          disabled={pending}
          aria-label="Behind a CDN"
        />
      </CardHeader>
      {on && (
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              CDN
              <Combobox
                aria-label="CDN"
                value={id}
                onValueChange={(v) => (v === NEW ? setAdding(true) : setId(v))}
                className="w-64"
                options={[
                  ...providers.map((p) => ({
                    value: p.id,
                    label: p.label,
                    description: p.builtin ? 'Built in' : 'Added by you',
                  })),
                  { value: NEW, label: 'Another CDN…' },
                ]}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}{' '}
              Refresh ranges
            </Button>
          </div>

          {current && (
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">
                {rangesSummary(current)}.
                {current.source &&
                  current.ranges > 0 &&
                  ' They are refreshed automatically.'}
              </p>
              {current.clientIpHeader ? (
                <p className="flex flex-wrap items-center gap-2">
                  The visitor’s address is in the{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {current.clientIpHeader}
                  </code>{' '}
                  header: read that one in the app.
                  <CopyButton value={current.clientIpHeader} />
                </p>
              ) : (
                <p className="text-muted-foreground">
                  The visitor’s address is the first entry of X-Forwarded-For,
                  which a visitor can forge. Use the CDN’s own header if it has
                  one.
                </p>
              )}
              {current.error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 text-amber-700 dark:text-amber-400"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  The last refresh failed ({current.error}). The ranges saved
                  before are still in use.
                </p>
              )}
              {!current.builtin && current.apps.length === 0 && (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const r = await removeCdnProviderAction(current.id);
                      if (!r.ok) return toast.error(r.error);
                      setProviders(providers.filter((p) => p.id !== id));
                      setId('cloudfront');
                      toast.success(`${current.label} removed.`);
                    }}
                  >
                    Remove {current.label}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-start gap-3">
            <Switch
              id="cdn-enforce"
              checked={enforce}
              onCheckedChange={(v) =>
                v ? setConfirming(true) : setEnforce(false)
              }
              aria-label="Only allow requests from the CDN"
            />
            <label
              htmlFor="cdn-enforce"
              className="flex flex-col gap-0.5 text-sm"
            >
              <span className="font-medium">
                Only allow requests from the CDN
              </span>
              <span className="text-muted-foreground">
                Anyone who reaches the server another way gets a “403
                Forbidden”. It also stops them forging the visitor’s address.
              </span>
            </label>
          </div>
        </CardContent>
      )}
      <CardContent className="flex items-center gap-3 pt-0">
        <Button disabled={pending || !dirty} onClick={save}>
          Save
        </Button>
        {on && (
          <span className="text-xs text-muted-foreground">
            Saving applies at once. If this is the first app behind this CDN,
            the proxy restarts for a second or two.
          </span>
        )}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Only allow the CDN?</AlertDialogTitle>
            <AlertDialogDescription>
              Once saved, requests that do not come from{' '}
              {current?.label ?? 'the CDN'}’s address ranges are refused,
              including your own if you open the server’s address directly.
              Check that the CDN reaches this app first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => setEnforce(true)}>
              Turn on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddCdnDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(p) => {
          setProviders((ps) => [...ps.filter((x) => x.id !== p.id), p]);
          setId(p.id);
        }}
      />
    </Card>
  );
}

function AddCdnDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (p: CdnProvider) => void;
}) {
  const [label, setLabel] = useState('');
  const [header, setHeader] = useState('');
  const [fromUrl, setFromUrl] = useState(false);
  const [url, setUrl] = useState('');
  const [ranges, setRanges] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const r = await saveCdnProviderAction({
        label,
        clientIpHeader: header,
        ...(fromUrl ? { url } : { ranges }),
      });
      if (!r.ok) return setError(r.error);
      const list = await refreshCdnAction();
      const added = list.ok ? list.data?.find((p) => p.id === r.data) : null;
      onAdded(
        added ?? {
          id: r.data as string,
          label,
          builtin: false,
          clientIpHeader: header || null,
          source: fromUrl ? url : null,
          ranges: 0,
          fetchedAt: null,
          error: null,
          apps: [],
        },
      );
      toast.success(`${label} added.`);
      onOpenChange(false);
      setLabel('');
      setHeader('');
      setUrl('');
      setRanges('');
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add a CDN</AlertDialogTitle>
          <AlertDialogDescription>
            Name it, and give the address ranges it connects from: typed in, or
            an address that serves them (refreshed automatically).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1.5 font-medium">
            Name
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Bunny CDN"
            />
          </label>
          <label className="flex flex-col gap-1.5 font-medium">
            Header with the visitor’s address (optional)
            <Input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              className="font-mono"
              placeholder="True-Client-IP"
            />
          </label>
          <div className="flex items-center gap-2">
            <Switch
              checked={fromUrl}
              onCheckedChange={setFromUrl}
              aria-label="Fetch the ranges from an address"
            />
            <span>Fetch the ranges from an address</span>
          </div>
          {fromUrl ? (
            <Input
              aria-label="Address of the list"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="font-mono"
              placeholder="https://example.com/ips.txt"
            />
          ) : (
            <textarea
              aria-label="Address ranges"
              value={ranges}
              onChange={(e) => setRanges(e.target.value)}
              spellCheck={false}
              rows={5}
              placeholder={'203.0.113.0/24\n2001:db8::/32'}
              className="rounded-md border bg-background p-2 font-mono text-xs"
            />
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button onClick={submit} disabled={pending || !label.trim()}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Add
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
