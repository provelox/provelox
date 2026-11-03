'use client';

import { useActionState, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  createAccessTokenAction,
  revokeAccessTokenAction,
  type CreateTokenState,
} from '@/actions/access-tokens';
import { Badge } from '@/components/ui/badge';
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
import { Combobox } from '@/components/ui/combobox';
import { SubmitButton } from '@/components/ui/submit-button';
import type { AccessToken } from '@/lib/backend';

const SCOPES = {
  read: 'Read only',
  operate: 'Read and operate',
  update: 'Read, operate and update',
} as const;

export function AccessTokensPanel({ tokens }: { tokens: AccessToken[] }) {
  const [state, action] = useActionState<CreateTokenState, FormData>(
    createAccessTokenAction,
    {},
  );
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access tokens</CardTitle>
        <CardDescription>
          Let another system, such as a monitoring hub, look at this instance
          without your password. <strong>Read only</strong> shows status and
          usage. <strong>Read and operate</strong> can also restart, start, stop
          and deploy apps and read their logs.{' '}
          <strong>Read, operate and update</strong> can also move this platform
          to another release. None can change settings, secrets or credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form action={action} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="token-name" className="text-xs font-medium">
              Name
            </label>
            <Input
              id="token-name"
              name="name"
              placeholder="Provelox Hub"
              required
              maxLength={60}
              className="w-56"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="token-scope" className="text-xs font-medium">
              Allowed to
            </label>
            <Combobox
              name="scope"
              required
              id="token-scope"
              className="w-56"
              aria-label="Allowed to"
              placeholder="Choose"
              options={Object.entries(SCOPES).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <SubmitButton>Create token</SubmitButton>
        </form>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        {state.created && (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4"
          >
            <p className="text-sm font-medium">
              Token &ldquo;{state.created.name}&rdquo; created. Copy it now, it
              is shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-xs">
                {state.created.token}
              </code>
              <CopyButton value={state.created.token} />
            </div>
          </div>
        )}

        <div className="divide-y">
          {tokens.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">No tokens yet.</p>
          )}
          {tokens.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {t.name} <Badge>{SCOPES[t.scope]}</Badge>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Created {new Date(t.createdAt).toLocaleDateString()} ·{' '}
                  {t.lastUsedAt
                    ? `last used ${new Date(t.lastUsedAt).toLocaleString()}`
                    : 'never used'}
                </p>
              </div>
              {confirmId === t.id ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const res = await revokeAccessTokenAction(t.id);
                        if (res.ok) toast.success('Token revoked');
                        else toast.error(res.error);
                        setConfirmId(null);
                      })
                    }
                  >
                    Revoke now
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmId(t.id)}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
