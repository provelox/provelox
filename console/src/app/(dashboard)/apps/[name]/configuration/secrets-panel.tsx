'use client';

import { KeyRound, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { deleteAppSecretAction, setAppSecretAction } from '@/actions/secrets';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type Secret = { name: string; createdAt: string };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Multi-line capable, masked like a password field. */
function SecretValueInput({
  value,
  onChange,
  label,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  autoFocus?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      rows={2}
      placeholder="Value (never shown again)"
      className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs [-webkit-text-security:disc] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

export function SecretsPanel({
  appName,
  secrets,
  missing = [],
}: {
  appName: string;
  secrets: Secret[];
  /** Names Docker no longer holds */
  missing?: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const nameProblem =
    name && !NAME_RE.test(name)
      ? 'Letters, numbers, dots, dashes and underscores only'
      : null;
  const exists = secrets.some((s) => s.name === name);

  function save(secretName: string, secretValue: string, done: () => void) {
    setWorking(secretName);
    startTransition(async () => {
      const res = await setAppSecretAction(appName, secretName, secretValue);
      if (res.ok) {
        toast.success(`Saved ${secretName}. The app is restarting.`);
        done();
      } else toast.error(res.error);
      setWorking(null);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>
            Write-only values, mounted in the container as files at{' '}
            <code>/run/secrets/&lt;name&gt;</code>. They can be replaced or
            deleted but never read back. Many images read one through a{' '}
            <code>*_FILE</code> variable, such as{' '}
            <code>POSTGRES_PASSWORD_FILE=/run/secrets/db-password</code> (set it
            under Environment). Saving restarts the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {secrets.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">
              No secrets yet.
            </p>
          )}
          {secrets.map((s) => (
            <div key={s.name} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-mono text-sm">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                    /run/secrets/{s.name}
                  </p>
                  {missing.includes(s.name) ? (
                    <p className="text-xs text-destructive">
                      Missing from Docker. Set it again, or delete it if the app
                      does not need it.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Set {new Date(s.createdAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {deleting === s.name ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => {
                          setWorking(s.name);
                          startTransition(async () => {
                            const res = await deleteAppSecretAction(
                              appName,
                              s.name,
                            );
                            if (res.ok)
                              toast.success(
                                `Deleted ${s.name}. The app is restarting.`,
                              );
                            else toast.error(res.error);
                            setDeleting(null);
                            setWorking(null);
                          });
                        }}
                      >
                        {working === s.name && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        Delete now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleting(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setReplacing(replacing === s.name ? null : s.name);
                          setReplacement('');
                        }}
                      >
                        Replace value
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setDeleting(s.name)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {replacing === s.name && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save(s.name, replacement, () => {
                      setReplacing(null);
                      setReplacement('');
                    });
                  }}
                >
                  <SecretValueInput
                    value={replacement}
                    onChange={setReplacement}
                    label={`New value for ${s.name}`}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={pending || !replacement}
                    >
                      {working === s.name && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      Save and restart
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setReplacing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </CardContent>
        <CardContent className="border-t pt-4">
          <p className="mb-3 text-sm font-medium">Add or replace a secret</p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save(name, value, () => {
                setName('');
                setValue('');
              });
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="db-password"
              aria-label="Secret name"
              aria-invalid={!!nameProblem}
              className="max-w-sm font-mono"
            />
            {nameProblem && (
              <p role="alert" className="text-xs text-destructive">
                {nameProblem}
              </p>
            )}
            <SecretValueInput
              value={value}
              onChange={setValue}
              label="Secret value"
            />
            {exists && name && (
              <p className="text-xs text-muted-foreground">
                A secret named {name} already exists and will be replaced.
              </p>
            )}
            <div>
              <Button
                type="submit"
                size="sm"
                disabled={pending || !name || !!nameProblem || !value}
              >
                {working === name && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {exists ? 'Replace and restart' : 'Save and restart'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
