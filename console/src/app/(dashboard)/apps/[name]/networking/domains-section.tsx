'use client';

import {
  ChevronDown,
  ExternalLink,
  Loader2,
  Lock,
  LockOpen,
  Plus,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  enableCustomDomainSslAction,
  enableDefaultSubDomainSslAction,
  removeCustomDomainAction,
} from '@/actions/domains';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiGet } from '@/lib/client-api';
import { certificatePollMs, describeCertificate } from '@/lib/certificates';
import type { CertificateStatus } from '@/lib/backend';
import { siteUrl, type ProxyPorts } from '@/lib/site-url';
import type { AppDefinition } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useUpdateApp } from '../use-update-app';
import { AddDomainWizard } from './add-domain-wizard';
import { CertificatePanel } from './certificate-panel';
import { DnsHelp } from './dns-help';

interface Row {
  host: string;
  ssl: boolean;
  isDefault: boolean;
}

function SslBadge({ on }: { on: boolean }) {
  return on ? (
    <Badge variant="success">
      <Lock className="mr-1 h-3 w-3" /> HTTPS
    </Badge>
  ) : (
    <Badge variant="warning">
      <LockOpen className="mr-1 h-3 w-3" /> HTTP only
    </Badge>
  );
}

/** Every address the app answers on, default and custom, in one list. Adding a domain opens a wizard. */
export function DomainsSection({
  app,
  defaultDomain,
  ports,
  httpsReady,
}: {
  app: AppDefinition;
  defaultDomain: string;
  ports?: ProxyPorts;
  httpsReady: boolean;
}) {
  const { update, pending: updating } = useUpdateApp(app.appName);
  const [view, applyOptimistic] = useOptimistic(
    app,
    (cur, patch: Partial<AppDefinition>) => ({ ...cur, ...patch }),
  );
  const [pending, startTransition] = useTransition();
  const [working, setWorking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [help, setHelp] = useState<Record<string, boolean>>({});
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['certificates', app.appName] });
    router.refresh();
  };

  // The certificate the proxy really serves for each address, checked now and then (and often while one is awaited)
  const certs = useQuery({
    queryKey: ['certificates', app.appName, app.customDomain.length],
    queryFn: () => apiGet<CertificateStatus[]>(`certificates/${app.appName}`),
    refetchInterval: (q) =>
      certificatePollMs((q.state.data ?? []).map((c) => c.state)),
  });
  const certOf = (host: string) => certs.data?.find((c) => c.host === host);

  const busy = pending || updating;
  const defaultOn = !view.disableDefaultSubDomain;

  function run(
    key: string,
    work: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) {
    setWorking(key);
    startTransition(async () => {
      const res = await work();
      if (res.ok) toast.success(success);
      else toast.error(res.error ?? 'Request failed');
      setWorking(null);
      setRemoving(null);
    });
  }

  const rows: Row[] = [
    ...(defaultOn
      ? [
          {
            host: defaultDomain,
            ssl: app.hasDefaultSubDomainSsl,
            isDefault: true,
          },
        ]
      : []),
    ...app.customDomain.map((d) => ({
      host: d.publicDomain,
      ssl: d.hasSsl,
      isDefault: false,
    })),
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Domains & HTTPS</CardTitle>
          <CardDescription>
            Every address {app.appName} answers on.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setWizard(true)}>
          <Plus className="h-4 w-4" /> Add domain
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {rows.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            No domains. Turn the default subdomain on, or add a custom one.
          </p>
        )}
        {rows.length > 1 && !view.primaryDomain && (
          <p className="pb-2 text-xs text-muted-foreground">
            Every address serves the app. Make one primary and the others
            redirect to it, for example coptev.com to www.coptev.com.
          </p>
        )}
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <li
              key={r.host}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <a
                  href={siteUrl(r, ports)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-w-0 items-center gap-1 font-mono text-sm hover:underline"
                >
                  <span className="truncate">{r.host}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </a>
                <Badge>{r.isDefault ? 'Default' : 'Custom'}</Badge>
                <SslBadge on={r.ssl} />
                {view.primaryDomain === r.host && (
                  <Badge variant="success">Primary</Badge>
                )}
              </div>
              {view.primaryDomain && view.primaryDomain !== r.host && (
                <p className="order-last basis-full text-xs text-muted-foreground">
                  Redirects to {view.primaryDomain}, keeping the path.
                </p>
              )}
              {(() => {
                // The panel below says all of this and more when a certificate is awaited or has a problem
                const state = certOf(r.host)?.state;
                const panelled =
                  r.ssl &&
                  (state === 'pending' ||
                    state === 'expired' ||
                    state === 'expiring');
                const line =
                  !panelled &&
                  certOf(r.host) &&
                  describeCertificate(certOf(r.host)!);
                return line ? (
                  <p
                    className={cn(
                      'order-last basis-full text-xs',
                      line.tone === 'ok' &&
                        'text-emerald-700 dark:text-emerald-400',
                      line.tone === 'warn' &&
                        'text-amber-700 dark:text-amber-400',
                      line.tone === 'bad' && 'text-destructive',
                      line.tone === 'muted' && 'text-muted-foreground',
                    )}
                  >
                    {line.text}
                  </p>
                ) : null;
              })()}
              {(() => {
                const state = certOf(r.host)?.state;
                const needsCert =
                  r.ssl &&
                  (state === 'pending' ||
                    state === 'expired' ||
                    state === 'expiring');
                const open = !r.isDefault && help[r.host];
                return needsCert || open ? (
                  <div className="order-last flex basis-full flex-col gap-3">
                    {open && (
                      <DnsHelp
                        host={r.host}
                        defaultDomain={defaultDomain}
                        appName={app.appName}
                        httpsOffer={
                          r.ssl ? null : { httpsReady, onEnabled: refresh }
                        }
                      />
                    )}
                    {r.ssl && (
                      <CertificatePanel
                        appName={app.appName}
                        host={r.host}
                        onIssued={refresh}
                      />
                    )}
                  </div>
                ) : null;
              })()}
              <div className="flex shrink-0 gap-2">
                {!r.isDefault && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={!!help[r.host]}
                    onClick={() =>
                      setHelp((h) => ({ ...h, [r.host]: !h[r.host] }))
                    }
                  >
                    DNS
                    <ChevronDown
                      className={cn(
                        'h-4 w-4 transition-transform',
                        help[r.host] && 'rotate-180',
                      )}
                    />
                  </Button>
                )}
                {rows.length > 1 &&
                  (view.primaryDomain === r.host ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        update(
                          { primaryDomain: null },
                          'Other addresses no longer redirect',
                          () => applyOptimistic({ primaryDomain: undefined }),
                        )
                      }
                    >
                      Stop redirecting
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        update(
                          { primaryDomain: r.host },
                          `Other addresses now redirect to ${r.host}`,
                          () => applyOptimistic({ primaryDomain: r.host }),
                        )
                      }
                    >
                      Make primary
                    </Button>
                  ))}
                {!r.ssl && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(
                        `ssl:${r.host}`,
                        () =>
                          r.isDefault
                            ? enableDefaultSubDomainSslAction(app.appName)
                            : enableCustomDomainSslAction(app.appName, r.host),
                        `HTTPS enabled for ${r.host}`,
                      )
                    }
                  >
                    {working === `ssl:${r.host}` && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    Enable HTTPS
                  </Button>
                )}
                {!r.isDefault &&
                  (removing === r.host ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() =>
                          run(
                            `rm:${r.host}`,
                            () => removeCustomDomainAction(app.appName, r.host),
                            `Removed ${r.host}`,
                          )
                        }
                      >
                        Remove now
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
                      disabled={busy}
                      onClick={() => setRemoving(r.host)}
                    >
                      Remove
                    </Button>
                  ))}
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-3 grid gap-x-8 divide-y sm:grid-cols-2 sm:divide-y-0">
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm font-medium">Serve default subdomain</p>
              <p className="text-xs text-muted-foreground">
                Turn off to serve only your custom domains.
              </p>
            </div>
            <Switch
              checked={defaultOn}
              disabled={busy}
              aria-label="Serve default subdomain"
              onCheckedChange={(on) =>
                update(
                  { disableDefaultSubDomain: !on },
                  on
                    ? 'Default subdomain enabled'
                    : 'Default subdomain disabled',
                  () => applyOptimistic({ disableDefaultSubDomain: !on }),
                )
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm font-medium">Force HTTPS</p>
              <p className="text-xs text-muted-foreground">
                Redirect HTTP to HTTPS on every domain of this app.
              </p>
            </div>
            <Switch
              checked={view.forceSsl}
              disabled={busy}
              aria-label="Force HTTPS"
              onCheckedChange={(on) =>
                update({ forceSsl: on }, 'Saved', () =>
                  applyOptimistic({ forceSsl: on }),
                )
              }
            />
          </div>
        </div>
      </CardContent>
      <AddDomainWizard
        open={wizard}
        onOpenChange={setWizard}
        appName={app.appName}
        defaultDomain={defaultDomain}
        existing={app.customDomain.map((d) => d.publicDomain)}
        httpsReady={httpsReady}
        forceSsl={app.forceSsl}
        ports={ports}
      />
    </Card>
  );
}
