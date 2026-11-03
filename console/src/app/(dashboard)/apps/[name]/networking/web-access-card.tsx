'use client';

import { Globe, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateAppAction } from '@/actions/apps';
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
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/ui/copy-button';
import { Switch } from '@/components/ui/switch';
import type { AppDefinition } from '@/lib/types';
import { useUpdateApp } from '../use-update-app';

/**
 * Whether the proxy serves the app over HTTP(S) at all. Turned off it ignores the app, which is what a DNS server, a
 * database or a mail server wants: they are reached on the ports they publish, not through the web proxy. A domain can
 * still be linked, for identification and to point DNS at this server; it is never routed.
 */
export function WebAccessCard({ app }: { app: AppDefinition }) {
  const { update, pending } = useUpdateApp(app.appName);
  const [view, apply] = useOptimistic(
    app,
    (cur, patch: Partial<AppDefinition>) => ({ ...cur, ...patch }),
  );
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(app.linkedDomain ?? '');
  // A saved domain is shown as plain text; the field comes back only when you ask to change it
  const [editing, setEditing] = useState(!app.linkedDomain);
  const [saving, startSaving] = useTransition();
  const web = !view.notExposeAsWebApp;
  const addresses = [
    ...(view.disableDefaultSubDomain ? [] : ['the default address']),
    ...view.customDomain.map((d) => d.publicDomain),
  ];
  const published = view.ports.length;
  const dirty = draft.trim().toLowerCase() !== (app.linkedDomain ?? '');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" aria-hidden="true" /> Web access
        </CardTitle>
        <CardDescription>
          Serve this app as a website through the proxy. Turn it off for things
          that are not web pages, such as a DNS server, a database or a mail
          server: they are reached on the ports they publish instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Serve over HTTP(S)</p>
            <p className="text-xs text-muted-foreground">
              {web
                ? 'The proxy answers for this app at its addresses.'
                : 'The proxy ignores this app. Other apps can still reach it on the instance’s internal network.'}
            </p>
          </div>
          <Switch
            checked={web}
            disabled={pending}
            aria-label="Serve over HTTP(S)"
            onCheckedChange={(on) => {
              if (!on && addresses.length > 0) setConfirming(true);
              else
                update(
                  { notExposeAsWebApp: !on },
                  on ? 'Serving over HTTP(S)' : 'No longer served over HTTP(S)',
                  () => apply({ notExposeAsWebApp: !on }),
                );
            }}
          />
        </div>

        {!web && (
          <div className="flex flex-col gap-2 border-t pt-4">
            <p className="text-sm font-medium">Domain name for this server</p>
            {view.linkedDomain && !editing ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-sm">
                  {view.linkedDomain}
                </code>
                <CopyButton value={view.linkedDomain} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(view.linkedDomain ?? '');
                    setEditing(true);
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = draft.trim().toLowerCase();
                  startSaving(async () => {
                    apply({ linkedDomain: v || undefined });
                    const res = await updateAppAction(app.appName, {
                      linkedDomain: v || null,
                    });
                    if (res.ok) {
                      toast.success(v ? 'Domain linked' : 'Domain removed');
                      setEditing(!v);
                    } else toast.error(res.error);
                  });
                }}
              >
                <Input
                  id="linked-domain"
                  aria-label="Domain name for this server"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="ns1.example.org"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!!app.linkedDomain}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={saving || (!dirty && !!app.linkedDomain)}
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {draft.trim() ? 'Save' : 'Remove'}
                </Button>
                {app.linkedDomain && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft(app.linkedDomain ?? '');
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </form>
            )}
            <p className="text-xs text-muted-foreground">
              A name for this app, for identification and for pointing at the
              server: create an A record (and AAAA for IPv6) for it at your DNS
              provider with this server’s public IP address. Provelox does not
              route web traffic to it.
            </p>
            <p className="text-xs text-muted-foreground">
              {published > 0 ? (
                <>
                  Reached on {published} published{' '}
                  {published === 1 ? 'port' : 'ports'}. See{' '}
                  <Link href="#ports" className="text-link hover:underline">
                    Port forwarding
                  </Link>
                  .
                </>
              ) : (
                <>
                  Nothing is published yet, so it cannot be reached from
                  outside. Add the ports it listens on under{' '}
                  <Link href="#ports" className="text-link hover:underline">
                    Port forwarding
                  </Link>
                  .
                </>
              )}
            </p>
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop serving this app over HTTP(S)?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {addresses.join(', ')} will stop answering. They stay on the
              Domains list and work again if you turn this back on. Ports it
              publishes are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                update(
                  { notExposeAsWebApp: true },
                  'No longer served over HTTP(S)',
                  () => apply({ notExposeAsWebApp: true }),
                )
              }
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
