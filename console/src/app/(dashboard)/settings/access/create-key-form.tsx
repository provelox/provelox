'use client';

import { useActionState } from 'react';
import { createApiKeyAction, type CreateKeyState } from '@/actions/api-keys';
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

function snippet(apiUrl: string) {
  return `- name: Deploy to Provelox
  run: |
    curl -fsS -X POST "${apiUrl}/v1/ci/deploy" \\
      -H "Authorization: Bearer \${{ secrets.PROVELOX_DEPLOY_KEY }}" \\
      -H "Content-Type: application/json" \\
      -d '{"image":"ghcr.io/your-org/your-app:\${{ github.sha }}"}'`;
}

export function CreateKeyForm({
  apps,
  apiUrl,
  fixedApp,
}: {
  apps: string[];
  apiUrl: string;
  /** On an app's own page the key is for that app, so there is nothing to choose */
  fixedApp?: string;
}) {
  const [state, action] = useActionState<CreateKeyState, FormData>(
    createApiKeyAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>CI deploy keys</CardTitle>
        <CardDescription>
          {fixedApp
            ? `A key can deploy ${fixedApp}, and nothing else.`
            : 'A key can deploy one app, and nothing else.'}{' '}
          Use it from CI instead of sharing your admin password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form action={action} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="key-name" className="text-xs font-medium">
              Name
            </label>
            <Input
              id="key-name"
              name="name"
              placeholder="GitHub Actions"
              required
              maxLength={60}
              className="w-56"
            />
          </div>
          {fixedApp ? (
            <input type="hidden" name="appName" value={fixedApp} />
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor="key-app" className="text-xs font-medium">
                App
              </label>
              <Combobox
                name="appName"
                required
                id="key-app"
                className="w-56"
                aria-label="App"
                placeholder="Choose an app"
                options={apps.map((a) => ({ value: a, label: a }))}
              />
            </div>
          )}
          <SubmitButton disabled={!fixedApp && apps.length === 0}>
            Create key
          </SubmitButton>
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
              Key &ldquo;{state.created.name}&rdquo; for {state.created.appName}{' '}
              created. Copy it now, it is shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-xs">
                {state.created.key}
              </code>
              <CopyButton value={state.created.key} />
            </div>
            <p className="text-xs text-muted-foreground">
              Add it to your repository secrets as{' '}
              <code>PROVELOX_DEPLOY_KEY</code>, then use:
            </p>
            <pre className="overflow-auto rounded-sm bg-muted p-3 font-mono text-xs">
              {snippet(apiUrl)}
            </pre>
            <div>
              <CopyButton value={snippet(apiUrl)} label="Copy workflow step" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
