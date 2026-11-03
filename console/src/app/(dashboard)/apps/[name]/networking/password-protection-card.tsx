'use client';

import { Dices, Lock, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  buildAuthPatch,
  generatePassword,
  parsePaths,
  type AuthRow,
} from '@/lib/basic-auth';
import { useUpdateApp } from '../use-update-app';

/**
 * Asks everyone for a username and password before the app (HTTP basic auth), done by the proxy so it works for any
 * app. Passwords are stored as hashes and cannot be shown again: to change one, type a new one. Chosen paths stay open
 * for what must be reachable without a password (a webhook, a health check).
 */
export function PasswordProtectionCard({
  appName,
  initial,
}: {
  appName: string;
  initial?: { users: string[]; openPaths: string[] };
}) {
  const { update, pending } = useUpdateApp(appName);
  const [on, setOn] = useState(!!initial);
  const [rows, setRows] = useState<AuthRow[]>(
    initial
      ? initial.users.map((name) => ({ name, password: '', saved: true }))
      : [],
  );
  const [paths, setPaths] = useState((initial?.openPaths ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);

  const set = (i: number, patch: Partial<AuthRow>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  function toggle(next: boolean) {
    setOn(next);
    setError(null);
    if (next && rows.length === 0)
      setRows([{ name: 'admin', password: generatePassword(), saved: false }]);
    if (!next && initial)
      // turning it off is a change that reaches the app at once: say so, and do it on Save
      setRows(
        initial.users.map((name) => ({ name, password: '', saved: true })),
      );
  }

  function save() {
    if (!on)
      return update(
        { basicAuth: null },
        'Password removed. The app is open again.',
      );
    const built = buildAuthPatch(rows, parsePaths(paths));
    if (!built.ok) return setError(built.error);
    setError(null);
    update(
      { basicAuth: built.patch },
      'Saved. Visitors are asked for the password.',
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" aria-hidden="true" /> Password protection
          </CardTitle>
          <CardDescription>
            Ask for a username and password before the app, at every address it
            has. Passwords are kept only as hashes, so they cannot be shown
            again: type a new one to change it.
          </CardDescription>
        </div>
        <Switch
          checked={on}
          onCheckedChange={toggle}
          disabled={pending}
          aria-label="Password protection"
        />
      </CardHeader>
      {on && (
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="User name"
                  value={r.name}
                  onChange={(e) => set(i, { name: e.target.value })}
                  readOnly={r.saved}
                  className="w-48 font-mono"
                  placeholder="user"
                />
                <Input
                  aria-label={
                    r.saved ? 'New password (leave empty to keep)' : 'Password'
                  }
                  type={r.revealed || !r.saved ? 'text' : 'password'}
                  value={r.password}
                  onChange={(e) =>
                    set(i, { password: e.target.value, revealed: true })
                  }
                  autoComplete="new-password"
                  className="min-w-56 flex-1 font-mono"
                  placeholder={
                    r.saved
                      ? 'unchanged: type to change'
                      : 'at least 8 characters'
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    set(i, { password: generatePassword(), revealed: true })
                  }
                >
                  <Dices className="h-4 w-4" /> Generate
                </Button>
                {r.password && <CopyButton value={r.password} />}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${r.name || 'user'}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows(rows.filter((_, n) => n !== i))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rows.length >= 20}
                onClick={() =>
                  setRows([
                    ...rows,
                    { name: '', password: generatePassword(), saved: false },
                  ])
                }
              >
                <Plus className="h-4 w-4" /> Add a user
              </Button>
            </div>
          </div>

          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Paths that stay open (one per line)
            <textarea
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              spellCheck={false}
              rows={3}
              placeholder={'/webhooks\n/health'}
              className="rounded-md border bg-background p-2 font-mono text-xs"
            />
            <span className="text-xs font-normal text-muted-foreground">
              Anything that starts with one of these is reachable without a
              password: for a webhook another service calls, or a health check.
              Leave empty to protect everything.
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      )}
      <CardContent className="flex items-center gap-3 pt-0">
        <Button disabled={pending || (!on && !initial)} onClick={save}>
          {on ? 'Save' : initial ? 'Remove the password' : 'Save'}
        </Button>
        {on && (
          <span className="text-xs text-muted-foreground">
            Saving applies at once; the app is not restarted.
          </span>
        )}
      </CardContent>
    </Card>
  );
}
