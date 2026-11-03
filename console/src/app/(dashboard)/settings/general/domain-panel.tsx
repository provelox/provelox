'use client';

import { Loader2, Pencil } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  changeRootDomainAction,
  type PlatformMove,
  setAcmeEmailAction,
  setAppDefaultsAction,
  serveOverHttpsAction,
  setAppsDomainAction,
} from '@/actions/system';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { PlatformHosts, SystemInfo } from '@/lib/backend';

const DOMAIN_RE =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turns what people paste ("https://Example.com/") into the bare domain the API wants. */
function clean(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

function Step({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${done ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-secondary text-muted-foreground'}`}
      >
        {done ? '✓' : n}
      </span>
      {title}
    </span>
  );
}

export type DomainInfo = Pick<
  SystemInfo,
  | 'rootDomain'
  | 'appsDomain'
  | 'appsDomainCustom'
  | 'acmeEmail'
  | 'defaultSubdomainForNewApps'
>;

export function DomainPanel({
  info,
  platformHosts,
}: {
  info: DomainInfo;
  platformHosts: PlatformHosts | null;
}) {
  const [pending, startTransition] = useTransition();
  const [working, setWorking] = useState<
    'domain' | 'apps' | 'email' | 'defaults' | 'https' | null
  >(null);
  const [defaultSub, setDefaultSub] = useState(info.defaultSubdomainForNewApps);
  const [domain, setDomain] = useState(info.rootDomain);
  // Closed once a domain is set: changing it moves every app and the console, so it should take a deliberate click
  const [editingDomain, setEditingDomain] = useState(!info.rootDomain);
  const [email, setEmail] = useState(info.acmeEmail);
  const [appsDomain, setAppsDomain] = useState(
    info.appsDomainCustom ? info.appsDomain : '',
  );
  const [editingApps, setEditingApps] = useState(false);
  const wantedApps = clean(appsDomain);
  const appsValid = DOMAIN_RE.test(wantedApps);
  const appsChanged =
    wantedApps !== (info.appsDomainCustom ? info.appsDomain : '');

  const wanted = clean(domain);
  const domainValid = DOMAIN_RE.test(wanted);
  const domainChanged = wanted !== info.rootDomain;
  const emailValid = EMAIL_RE.test(email.trim());
  const emailChanged = email.trim() !== info.acmeEmail;

  function run(
    key: 'domain' | 'apps' | 'email' | 'defaults',
    work: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
  ) {
    setWorking(key);
    startTransition(async () => {
      const res = await work();
      if (res.ok) toast.success(success);
      else toast.error(res.error ?? 'Request failed');
      setWorking(null);
    });
  }

  function saveDomain() {
    setWorking('domain');
    startTransition(async () => {
      const res = await changeRootDomainAction(wanted);
      if (res.ok) {
        announce(res.data?.platform);
        setEditingDomain(false);
      } else toast.error(res.error);
      setWorking(null);
    });
  }

  function cancelDomain() {
    setDomain(info.rootDomain);
    setEditingDomain(false);
  }

  function announce(platform?: PlatformMove) {
    toast.success(`Root domain set to ${wanted}`);
    if (platform?.reason) toast.warning(platform.reason, { duration: 20_000 });
    const target = platform?.moved ? platform.consoleUrl : undefined;
    if (target && new URL(target).host !== window.location.host)
      toast.success(`The console now lives at ${target}`, {
        description:
          'Open it and sign in again. Its HTTPS certificate can take up to a minute to appear.',
        duration: Infinity,
        action: {
          label: 'Open',
          onClick: () => window.location.assign(`${target}/settings/general`),
        },
      });
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>
              <Step n={1} title="Root domain" done={!!info.rootDomain} />
            </CardTitle>
            <CardDescription>
              Apps are served at{' '}
              <code>
                &lt;app-name&gt;.{info.rootDomain || 'your-domain.com'}
              </code>
              . Changing it updates every app&apos;s address and moves the
              console and API to <code>console.</code> and <code>api.</code>{' '}
              under the new domain.
            </CardDescription>
          </div>
          {!editingDomain && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditingDomain(true)}
            >
              <Pencil className="h-4 w-4" /> Change domain
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!editingDomain && (
            <p className="font-mono text-sm">{info.rootDomain}</p>
          )}
          {editingDomain && (
            <>
              <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                First create a <strong>wildcard DNS record</strong> at your DNS
                provider: type <code>A</code>, name{' '}
                <code>
                  *.{wanted && domainValid ? wanted : 'your-domain.com'}
                </code>
                , pointing to this server&apos;s public IP address. It also
                covers <code>console.</code> and <code>api.</code>. It can take
                a few minutes to take effect.
              </div>
              <form
                className="flex max-w-xl gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (domainValid && domainChanged) saveDomain();
                }}
              >
                <Input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="apps.example.com"
                  aria-label="Root domain"
                  aria-invalid={!!domain && !domainValid}
                  className="font-mono"
                />
                <Button
                  type="submit"
                  disabled={pending || !domainValid || !domainChanged}
                >
                  {working === 'domain' && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  Save
                </Button>
                {info.rootDomain && (
                  <Button type="button" variant="ghost" onClick={cancelDomain}>
                    Cancel
                  </Button>
                )}
              </form>
            </>
          )}
          {domain && !domainValid && (
            <p role="alert" className="text-xs text-destructive">
              Enter just the domain, for example apps.example.com (no https://
              and no path).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>
              <Step n={2} title="Domain for apps" done={!!info.appsDomain} />
            </CardTitle>
            <CardDescription>
              Optional. By default apps share the root domain, so{' '}
              <code>app-1</code> is at{' '}
              <code>app-1.{info.rootDomain || 'your-domain.com'}</code>. Set a
              domain here to keep the root domain for the console and API only:
              with <code>app.example.com</code>, <code>app-1</code> is at{' '}
              <code>app-1.app.example.com</code>. HTTPS works the same way.
            </CardDescription>
          </div>
          {!editingApps && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditingApps(true)}
            >
              <Pencil className="h-4 w-4" />{' '}
              {info.appsDomainCustom ? 'Change domain' : 'Set a domain'}
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!editingApps && (
            <p className="text-sm">
              {info.appsDomainCustom ? (
                <>
                  Apps are under{' '}
                  <code className="font-mono">{info.appsDomain}</code>.
                </>
              ) : (
                <span className="text-muted-foreground">
                  Apps use the root domain.
                </span>
              )}
            </p>
          )}
          {editingApps && (
            <>
              <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                Create a <strong>wildcard DNS record</strong> first: type{' '}
                <code>A</code>, name{' '}
                <code>
                  *.{wantedApps && appsValid ? wantedApps : 'app.example.com'}
                </code>
                , pointing to this server&apos;s public IP address. Existing
                apps move to their new address, and certificates are requested
                again for them.
              </div>
              <form
                className="flex max-w-xl gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (appsValid && appsChanged)
                    run(
                      'apps',
                      async () => {
                        const r = await setAppsDomainAction(wantedApps);
                        if (r.ok) setEditingApps(false);
                        return r;
                      },
                      `Apps are now under ${wantedApps}`,
                    );
                }}
              >
                <Input
                  value={appsDomain}
                  onChange={(e) => setAppsDomain(e.target.value)}
                  placeholder="app.example.com"
                  aria-label="Domain for apps"
                  aria-invalid={!!appsDomain && !appsValid}
                  className="font-mono"
                />
                <Button
                  type="submit"
                  disabled={pending || !appsValid || !appsChanged}
                >
                  {working === 'apps' && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  Save
                </Button>
                {info.appsDomainCustom && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(
                        'apps',
                        async () => {
                          const r = await setAppsDomainAction(null);
                          if (r.ok) {
                            setAppsDomain('');
                            setEditingApps(false);
                          }
                          return r;
                        },
                        'Apps use the root domain again',
                      )
                    }
                  >
                    Use the root domain
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setAppsDomain(info.appsDomainCustom ? info.appsDomain : '');
                    setEditingApps(false);
                  }}
                >
                  Cancel
                </Button>
              </form>
              {appsDomain && !appsValid && (
                <p role="alert" className="text-xs text-destructive">
                  Enter just the domain, for example app.example.com.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <Step n={3} title="HTTPS certificates" done={!!info.acmeEmail} />
          </CardTitle>
          <CardDescription>
            Let&apos;s Encrypt needs an email address to register your account
            and warn you before a certificate expires. Once it is set, turn on
            HTTPS for an app&apos;s address or custom domain under its{' '}
            <strong>Networking</strong> tab: the certificate is requested and
            renewed automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex max-w-xl gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (emailValid && emailChanged)
                run(
                  'email',
                  () => setAcmeEmailAction(email),
                  'Saved. The proxy restarts briefly to register the account.',
                );
            }}
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Let's Encrypt email"
              aria-invalid={!!email && !emailValid}
            />
            <Button
              type="submit"
              disabled={pending || !emailValid || !emailChanged}
            >
              {working === 'email' && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            A certificate is only issued if the domain points at this server and
            port 80 is reachable from the internet.{' '}
            {info.acmeEmail && <Badge variant="success">email set</Badge>}
          </p>
          {platformHosts && (platformHosts.console || platformHosts.api) && (
            <div className="mt-2 flex flex-col gap-2 rounded-md border p-3 text-sm">
              <p className="font-medium">Console and API</p>
              <ul className="flex flex-col gap-1 text-xs">
                {(['console', 'api'] as const).map((k) => {
                  const h = platformHosts[k];
                  return (
                    h && (
                      <li key={k} className="flex items-center gap-2">
                        <code className="font-mono">{h.host}</code>
                        <Badge variant={h.ssl ? 'success' : 'warning'}>
                          {h.ssl ? 'HTTPS' : 'plain HTTP'}
                        </Badge>
                      </li>
                    )
                  );
                })}
              </ul>
              {[platformHosts.console, platformHosts.api].some(
                (h) => h && !h.ssl,
              ) && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {info.acmeEmail
                      ? 'Sign-ins and tokens travel in clear text over plain HTTP. Serve them over HTTPS: certificates are requested now, and plain HTTP is redirected. The addresses must already point to this server, with ports 80 and 443 reachable. The certificate can take up to a minute to appear.'
                      : 'Save a Let’s Encrypt email above first: certificates are requested with it. Then the console and API can be served over HTTPS from here.'}
                  </p>
                  <div>
                    <Button
                      size="sm"
                      disabled={pending || !info.acmeEmail}
                      onClick={() => {
                        setWorking('https');
                        startTransition(async () => {
                          const res = await serveOverHttpsAction();
                          if (res.ok) {
                            const target = res.data?.consoleUrl;
                            toast.success(
                              'The console and API are now served over HTTPS',
                              target
                                ? {
                                    description:
                                      'The certificate can take up to a minute. Sign in again at the new address.',
                                    duration: Infinity,
                                    action: {
                                      label: 'Open',
                                      onClick: () =>
                                        window.location.assign(
                                          `${target}/settings/general`,
                                        ),
                                    },
                                  }
                                : undefined,
                            );
                          } else toast.error(res.error);
                          setWorking(null);
                        });
                      }}
                    >
                      {working === 'https' && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      Serve the console and API over HTTPS
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <Step n={4} title="Default address for new apps" done />
          </CardTitle>
          <CardDescription>
            Whether a new app is served at{' '}
            <code>&lt;app-name&gt;.{info.appsDomain || 'your-domain.com'}</code>{' '}
            unless you decide otherwise. Turn it off to keep apps off a default
            address, for example when each one has its own domain. Either way,
            you can choose per app when you create it, and change it later on
            the app&apos;s Networking tab. Apps that already exist are not
            changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                Give new apps a default address
              </p>
              <p className="text-xs text-muted-foreground">
                {defaultSub
                  ? 'New apps are reachable at their default address.'
                  : 'New apps have no default address until one is added.'}
              </p>
            </div>
            <Switch
              checked={defaultSub}
              disabled={pending}
              aria-label="Give new apps a default address"
              onCheckedChange={(on) => {
                setDefaultSub(on);
                run(
                  'defaults',
                  () => setAppDefaultsAction(on),
                  on
                    ? 'New apps get a default address'
                    : 'New apps start without a default address',
                );
              }}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
