'use client';

import { KeyRound, Loader2, TriangleAlert } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { removeSsoProviderAction, saveSsoProviderAction } from '@/actions/sso';
import {
  AlertDialog,
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
import { parsePaths } from '@/lib/basic-auth';
import {
  KIND_HELP,
  KIND_LABEL,
  splitWho,
  type SsoInfo,
  type SsoKind,
  type SsoProvider,
} from '@/lib/sso';
import { useUpdateApp } from '../use-update-app';

const NEW = '__new__';

type Saved = {
  provider: string;
  emails: string[];
  domains: string[];
  openPaths: string[];
};

/**
 * Asks visitors to sign in with Google, GitHub or a company identity provider before the app. The proxy checks it for
 * every request, so it works for any app, and the app is told who signed in (X-Provelox-Email, X-Provelox-User).
 */
export function SsoCard({
  appName,
  initial,
  info,
}: {
  appName: string;
  initial?: Saved;
  info: SsoInfo;
}) {
  const { update, pending } = useUpdateApp(appName);
  const [providers, setProviders] = useState(info.providers);
  const [on, setOn] = useState(!!initial);
  const [id, setId] = useState(initial?.provider ?? providers[0]?.id ?? '');
  const [who, setWho] = useState(
    [
      ...(initial?.emails ?? []),
      ...(initial?.domains ?? []).map((d) => `@${d}`),
    ].join('\n'),
  );
  const [paths, setPaths] = useState((initial?.openPaths ?? []).join('\n'));
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = providers.find((p) => p.id === id);
  const rules = splitWho(who);
  const dirty =
    on !== !!initial ||
    (on &&
      (id !== initial?.provider ||
        JSON.stringify(rules) !==
          JSON.stringify({
            emails: initial?.emails ?? [],
            domains: initial?.domains ?? [],
          }) ||
        JSON.stringify(parsePaths(paths)) !==
          JSON.stringify(initial?.openPaths ?? [])));

  function save() {
    setError(null);
    if (!on) return update({ sso: null }, 'Visitors no longer sign in.');
    if (!id) return setError('Add a sign-in provider first.');
    if (rules.emails.length + rules.domains.length === 0)
      return setError('Say who may sign in: an email address or a domain.');
    update(
      {
        sso: { provider: id, ...rules, openPaths: parsePaths(paths) },
      },
      'Saved. Visitors now sign in before they reach the app.',
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" aria-hidden="true" /> Sign in with…
          </CardTitle>
          <CardDescription>
            Ask visitors to sign in with Google, GitHub or your company’s
            identity provider before the app. Only the people you list get in.
            The app is told who they are, so it needs no sign-in of its own.
          </CardDescription>
        </div>
        <Switch
          checked={on}
          onCheckedChange={setOn}
          disabled={pending || (!info.available && !initial)}
          aria-label="Sign in with a provider"
        />
      </CardHeader>
      {!info.available && (
        <CardContent className="pt-0">
          <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            This needs the API reachable at an address of its own. Set one when
            installing (an API address), then come back.
          </p>
        </CardContent>
      )}
      {on && (
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Provider
              <Combobox
                aria-label="Sign-in provider"
                value={id}
                onValueChange={(v) => (v === NEW ? setAdding(true) : setId(v))}
                className="w-64"
                options={[
                  ...providers.map((p) => ({
                    value: p.id,
                    label: p.label,
                    description: KIND_LABEL[p.kind].split(' (')[0],
                  })),
                  { value: NEW, label: 'Add a provider…' },
                ]}
              />
            </label>
            {current && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const r = await removeSsoProviderAction(current.id);
                  if (!r.ok) return toast.error(r.error);
                  const rest = providers.filter((p) => p.id !== current.id);
                  setProviders(rest);
                  setId(rest[0]?.id ?? '');
                  toast.success(`${current.label} removed.`);
                }}
              >
                Remove {current.label}
              </Button>
            )}
          </div>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Who may sign in
            <textarea
              value={who}
              onChange={(e) => setWho(e.target.value)}
              spellCheck={false}
              rows={4}
              placeholder={'ada@example.com\n@yourcompany.com'}
              className="rounded-md border bg-background p-2 font-mono text-xs font-normal"
            />
            <span className="font-normal text-muted-foreground">
              One per line. An email address lets that person in; a domain such
              as <code className="font-mono">@yourcompany.com</code> lets in
              everyone with that address. Removing someone takes effect on their
              next request.
            </span>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Paths that stay open (optional)
            <textarea
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              spellCheck={false}
              rows={2}
              placeholder={'/webhooks\n/health'}
              className="rounded-md border bg-background p-2 font-mono text-xs font-normal"
            />
            <span className="font-normal text-muted-foreground">
              For what must be reachable without signing in: a webhook, a health
              check.
            </span>
          </label>

          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            The app receives
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              X-Provelox-Email
            </code>
            and
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              X-Provelox-User
            </code>
            on every request.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      )}
      <CardContent className="flex items-center gap-3 pt-0">
        <Button disabled={pending || !dirty} onClick={save}>
          Save
        </Button>
        {on && (
          <span className="text-xs text-muted-foreground">
            Saving applies at once. The app stays unreachable to anyone not
            listed.
          </span>
        )}
      </CardContent>

      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        redirectUri={info.redirectUri}
        onAdded={(p) => {
          setProviders((ps) => [...ps.filter((x) => x.id !== p.id), p]);
          setId(p.id);
        }}
      />
    </Card>
  );
}

function AddProviderDialog({
  open,
  onOpenChange,
  redirectUri,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  redirectUri: string | null;
  onAdded: (p: SsoProvider) => void;
}) {
  const [kind, setKind] = useState<SsoKind>('google');
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [issuer, setIssuer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const help = KIND_HELP[kind];
  const name = label.trim() || KIND_LABEL[kind].split(' (')[0];

  function submit() {
    setError(null);
    start(async () => {
      const r = await saveSsoProviderAction({
        kind,
        label: name,
        clientId,
        clientSecret: secret,
        issuer,
      });
      if (!r.ok) return setError(r.error);
      onAdded(r.data as SsoProvider);
      toast.success(`${name} added.`);
      onOpenChange(false);
      setLabel('');
      setClientId('');
      setSecret('');
      setIssuer('');
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add a sign-in provider</AlertDialogTitle>
          <AlertDialogDescription>
            Create an app at the provider, give it the address below as its
            redirect address, then paste the client ID and secret it shows. One
            provider can protect any number of apps.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1.5 font-medium">
            Kind
            <Combobox
              aria-label="Kind of provider"
              value={kind}
              onValueChange={(v) => setKind(v as SsoKind)}
              options={(Object.keys(KIND_LABEL) as SsoKind[]).map((k) => ({
                value: k,
                label: KIND_LABEL[k],
              }))}
            />
          </label>
          <p className="text-muted-foreground">
            {help.url ? (
              <a
                href={help.url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {help.text}
              </a>
            ) : (
              help.text
            )}
          </p>
          {redirectUri && (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium">Redirect address to register</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {redirectUri}
                </code>
                <CopyButton value={redirectUri} />
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1.5 font-medium">
            Name
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={KIND_LABEL[kind].split(' (')[0]}
            />
          </label>
          {kind === 'oidc' && (
            <label className="flex flex-col gap-1.5 font-medium">
              Issuer address
              <Input
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                className="font-mono"
                placeholder="https://yourcompany.okta.com"
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5 font-medium">
            Client ID
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 font-medium">
            Client secret
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="font-mono"
              autoComplete="new-password"
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            onClick={submit}
            disabled={pending || !clientId.trim() || !secret}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Add
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
