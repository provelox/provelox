'use client';

import {
  Check,
  ExternalLink,
  Info,
  KeyRound,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { RegistryLogo } from '@/components/registry-logo';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  addRegistryAction,
  checkPullAction,
  deleteRegistryAction,
  updateRegistryAction,
  type PullCheck,
  type RegistryInput,
} from '@/actions/registries';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  REGISTRY_PRESETS,
  checkRegistryInput,
  normalizeRegistryDomain,
  providerOf,
  registryForImage,
  type PublicRegistry,
  type RegistryPreset,
} from '@/lib/registries';
import { cn } from '@/lib/utils';

const EMPTY: RegistryInput = {
  registryDomain: '',
  registryUser: '',
  registryPassword: '',
};

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/**
 * Shared by "add" and "edit". The saved password is never available here, so on edit it can only be replaced.
 * A registry's address cannot change: to use another address, add another registry.
 */
function RegistryForm({
  initial,
  editing,
  preset,
  existing,
  exceptId,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: RegistryInput;
  editing: boolean;
  preset: RegistryPreset;
  existing: PublicRegistry[];
  exceptId?: string;
  pending: boolean;
  /** What the registry (or the server) said when the last try failed */
  error?: string;
  submitLabel: string;
  onSubmit: (value: RegistryInput) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState<RegistryInput>({
    ...initial,
    registryUser: initial.registryUser || preset.fixedUser || '',
  });
  // Nothing is called wrong before it was touched: errors wait for a field to be left or for a submit
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const set = (patch: Partial<RegistryInput>) =>
    setValue((v) => ({ ...v, ...patch }));

  const domain = normalizeRegistryDomain(value.registryDomain);
  const check = checkRegistryInput(
    preset,
    {
      domain: value.registryDomain,
      user: value.registryUser,
      secret: value.registryPassword,
    },
    { editing, existing, exceptId },
  );
  const show = (k: 'domain' | 'user' | 'secret') =>
    touched[k] ? check[k] : undefined;
  const fixedDomain = !!preset.domain;

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched({ domain: true, user: true, secret: true });
        if (!check.ok) return;
        onSubmit({
          registryDomain: domain,
          registryUser: value.registryUser.trim(),
          // a pasted token often carries a trailing newline
          registryPassword: preset.secretIsFile
            ? value.registryPassword.trim()
            : value.registryPassword.trim(),
        });
      }}
    >
      <Field
        label="Registry address"
        hint={
          editing
            ? 'The address cannot be changed. Add a new registry to use another one.'
            : fixedDomain
              ? undefined
              : domain && domain !== value.registryDomain.trim()
                ? `Will be saved as ${domain}`
                : 'Just the address, without https:// or a path.'
        }
      >
        {fixedDomain || editing ? (
          <span className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 font-mono text-sm">
            {editing ? value.registryDomain : preset.domain}
          </span>
        ) : (
          <Input
            value={value.registryDomain}
            onChange={(e) => set({ registryDomain: e.target.value })}
            onBlur={() => touch('domain')}
            placeholder={preset.domainPlaceholder}
            aria-label="Registry address"
            aria-invalid={!!show('domain')}
            className="font-mono"
            autoFocus={!editing}
          />
        )}
      </Field>
      {show('domain') && (
        <p role="alert" className="-mt-3 text-xs text-destructive">
          {show('domain')}
        </p>
      )}

      <Field label="Username" hint={preset.userHint}>
        <Input
          value={value.registryUser}
          onChange={(e) => set({ registryUser: e.target.value })}
          onBlur={() => touch('user')}
          autoComplete="off"
          aria-label="Registry username"
          aria-invalid={!!show('user')}
          readOnly={!!preset.fixedUser}
          className={preset.fixedUser ? 'bg-muted/40 font-mono' : undefined}
          autoFocus={fixedDomain && !preset.fixedUser && !editing}
        />
      </Field>
      {show('user') && (
        <p role="alert" className="-mt-3 text-xs text-destructive">
          {show('user')}
        </p>
      )}

      <Field
        label={
          editing
            ? `New ${preset.secretLabel.toLowerCase()} (leave empty to keep the saved one)`
            : preset.secretLabel
        }
        hint={preset.secretHint}
      >
        {preset.secretIsFile ? (
          <textarea
            value={value.registryPassword}
            onChange={(e) => set({ registryPassword: e.target.value })}
            onBlur={() => touch('secret')}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              editing ? '(unchanged)' : '{ "type": "service_account", … }'
            }
            aria-label="Registry password or token"
            aria-invalid={!!show('secret')}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
          />
        ) : (
          <Input
            type="password"
            value={value.registryPassword}
            onChange={(e) => set({ registryPassword: e.target.value })}
            onBlur={() => touch('secret')}
            autoComplete="new-password"
            placeholder={editing ? '••••••••  (unchanged)' : ''}
            aria-label="Registry password or token"
            aria-invalid={!!show('secret')}
          />
        )}
      </Field>
      {show('secret') && (
        <p role="alert" className="-mt-3 text-xs text-destructive">
          {show('secret')}
        </p>
      )}
      {touched.secret && !check.secret && check.warning && (
        <p className="-mt-3 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {check.warning}
        </p>
      )}

      {preset.note && !editing && (
        <p className="flex items-start gap-2 rounded-md border bg-secondary/30 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {preset.note}
        </p>
      )}
      {preset.help && (
        <a
          href={preset.help.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {preset.help.label} <ExternalLink className="h-3 w-3" />
        </a>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {error}
            {/rejected|credentials|denied|unauthorized/i.test(error) &&
              ' Check the username and that the token has read access to packages.'}
          </span>
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? `Checking with ${preset.label}…` : submitLabel}
        </Button>
        {onCancel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
        )}
        {!pending && (
          <span className="text-xs text-muted-foreground">
            The registry is asked to confirm the login before anything is saved.
          </span>
        )}
      </div>
    </form>
  );
}

export function RegistriesPanel({
  registries,
}: {
  registries: PublicRegistry[];
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(registries.length === 0);
  const [presetId, setPresetId] = useState('ghcr');
  // What the registry said when saving failed, shown in the form it belongs to
  const [formError, setFormError] = useState<string>();
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [image, setImage] = useState('');
  const [tested, setTested] = useState<{
    image: string;
    result: PullCheck;
  } | null>(null);
  const [testing, startTest] = useTransition();

  const preset = REGISTRY_PRESETS.find((p) => p.id === presetId)!;
  const match = image.trim()
    ? registryForImage(registries, image.trim())
    : undefined;

  /** For the add and edit forms: a failure stays in the form (where the fields are) instead of vanishing as a toast. */
  function submit(
    work: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    after?: () => void,
  ) {
    setFormError(undefined);
    startTransition(async () => {
      const res = await work();
      if (res.ok) {
        toast.success(success);
        after?.();
      } else setFormError(res.error ?? 'The request failed.');
    });
  }

  function run(
    work: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    after?: () => void,
  ) {
    startTransition(async () => {
      const res = await work();
      if (res.ok) {
        toast.success(success);
        after?.();
      } else toast.error(res.error ?? 'Request failed');
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>How registries are used</CardTitle>
          <CardDescription>
            When you deploy an image such as <code>ghcr.io/my-org/app:1</code>,
            Provelox uses the saved login for that registry&apos;s domain so
            Docker can pull your private images, including ones your CI pushes.
            Public images need nothing.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registries</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {registries.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">
              No registries yet. Add one below.
            </p>
          )}
          {registries.map((r) => (
            <div key={r.id} className="flex flex-col gap-3 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <RegistryLogo domain={r.registryDomain} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono">{r.registryDomain}</span>
                      <span className="text-xs text-muted-foreground">
                        {providerOf(r.registryDomain).label}
                      </span>
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <KeyRound className="h-3 w-3" /> {r.registryUser} ·
                      password saved (hidden)
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setFormError(undefined);
                      setEditing(editing === r.id ? null : r.id);
                    }}
                  >
                    Edit
                  </Button>
                  {removing === r.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => deleteRegistryAction(r.id),
                            `Removed ${r.registryDomain}`,
                            () => setRemoving(null),
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
                      disabled={pending}
                      onClick={() => setRemoving(r.id)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {editing === r.id && (
                <RegistryForm
                  initial={{
                    registryDomain: r.registryDomain,
                    registryUser: r.registryUser,
                    registryPassword: '',
                  }}
                  editing
                  preset={providerOf(r.registryDomain)}
                  existing={registries}
                  exceptId={r.id}
                  pending={pending}
                  error={formError}
                  submitLabel="Save changes"
                  onCancel={() => {
                    setEditing(null);
                    setFormError(undefined);
                  }}
                  onSubmit={(v) =>
                    submit(
                      () => updateRegistryAction(r.id, v),
                      'Registry updated',
                      () => setEditing(null),
                    )
                  }
                />
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Check an image</CardTitle>
          <CardDescription>
            See which saved credentials would be used to pull an image, and ask
            the registry whether they let it through.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {justAdded && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400"
            >
              <Check className="h-4 w-4" /> {justAdded} is saved. Type the rest
              of one of its images and test that it can be pulled.
            </p>
          )}
          <Input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="ghcr.io/my-org/my-app:latest"
            aria-label="Image name"
            className="max-w-xl font-mono"
          />
          {image.trim() &&
            (match ? (
              <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" /> Uses the login for{' '}
                {match.registryDomain} ({match.registryUser})
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No saved registry matches. It is pulled anonymously, which only
                works for public images.
              </p>
            ))}
          {image.trim() && (
            <div className="flex flex-col items-start gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={testing}
                onClick={() =>
                  startTest(async () => {
                    const r = await checkPullAction(image.trim());
                    if (r.ok && r.data)
                      setTested({ image: image.trim(), result: r.data });
                    else if (!r.ok) toast.error(r.error);
                  })
                }
              >
                {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                Test pull
              </Button>
              {tested && tested.image === image.trim() && (
                <p
                  role="status"
                  className={`text-sm ${tested.result.pull.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}
                >
                  {tested.result.pull.ok
                    ? `The registry lets this server pull it${tested.result.user ? `, with the login for ${tested.result.registry} (${tested.result.user})` : ' without a login'}.`
                    : `The registry refused${tested.result.user ? ` the saved login for ${tested.result.registry} (${tested.result.user})` : ` (no login is saved for ${tested.result.registry})`}: ${tested.result.pull.reason}${
                        tested.result.user
                          ? '. That login works for the registry but cannot read this image: use a token that can read packages, or make the image public.'
                          : '.'
                      }`}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Add a registry</CardTitle>
            <CardDescription>
              The password or token is sent to Provelox and stored encrypted. It
              is never shown again.
            </CardDescription>
          </div>
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add registry
            </Button>
          )}
        </CardHeader>
        {adding && (
          <CardContent className="flex flex-col gap-4">
            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
              role="radiogroup"
              aria-label="Registry provider"
            >
              {REGISTRY_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={presetId === p.id}
                  onClick={() => {
                    setPresetId(p.id);
                    setFormError(undefined);
                  }}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring',
                    presetId === p.id && 'border-primary bg-secondary/40',
                  )}
                >
                  <RegistryLogo preset={p} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {p.label}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {p.domain ||
                        p.domainPlaceholder?.replace(/^[^.]*\./, '…')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <RegistryForm
              key={presetId}
              initial={{ ...EMPTY, registryDomain: preset.domain }}
              editing={false}
              preset={preset}
              existing={registries}
              pending={pending}
              error={formError}
              submitLabel="Check login and save"
              onCancel={
                registries.length
                  ? () => {
                      setAdding(false);
                      setFormError(undefined);
                    }
                  : undefined
              }
              onSubmit={(v) =>
                submit(
                  () => addRegistryAction(v),
                  `Saved ${v.registryDomain}`,
                  () => {
                    setAdding(false);
                    setJustAdded(v.registryDomain);
                    // the next thing worth doing is trying it on one of its images
                    setImage(`${v.registryDomain}/`);
                  },
                )
              }
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
