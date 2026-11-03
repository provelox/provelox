'use client';

import { Eye, EyeOff } from 'lucide-react';
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
import { address, MASK, maskSecrets } from '@/lib/connection';
import type { ProjectTemplate } from '@/lib/types';

function Row({
  label,
  hint,
  value,
  copy,
  mono = true,
}: {
  label: string;
  hint?: string;
  value: string;
  /** What the Copy button copies, when it is not what is shown */
  copy?: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={mono ? 'truncate font-mono text-sm' : 'truncate text-sm'}>
          {value}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {copy !== null && <CopyButton value={copy ?? value} />}
    </div>
  );
}

/**
 * How to connect to what a template deployed: the addresses other apps and the project's own services use, a
 * connection string, and the values the template was given. Secrets are hidden until revealed.
 */
export function ConnectionCard({ template }: { template: ProjectTemplate }) {
  const [reveal, setReveal] = useState(false);
  const { connection: c, variables } = template;
  const shownUrl = c.url
    ? reveal
      ? c.url
      : maskSecrets(c.url, variables)
    : null;

  return (
    <Card id="connection" className="scroll-mt-24">
      <CardHeader className="flex-col sm:flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>
            {template.publicWeb ? 'Using ' : 'Connect to '}
            {template.name}
          </CardTitle>
          <CardDescription>
            {template.publicWeb
              ? 'This one is a web page. The address is in the services list.'
              : 'From another app on this server.'}
          </CardDescription>
        </div>
        {variables.some((v) => v.kind === 'secret' && v.value) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReveal((r) => !r)}
            aria-pressed={reveal}
          >
            {reveal ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            {reveal ? 'Hide' : 'Reveal'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="divide-y">
        {!template.publicWeb && (
          <>
            <Row
              label="Address for other apps"
              value={address(c, 'apps')}
              hint="Works from any app on this server."
            />
            <Row
              label="Address inside this project"
              value={address(c, 'project')}
              hint="For the project's own services."
            />
          </>
        )}
        {c.urlTemplate && (
          <Row
            label="Connection string"
            value={shownUrl ?? c.urlTemplate}
            copy={c.url}
            hint={
              c.url
                ? undefined
                : 'A value it needs could not be read back, so this is only the shape.'
            }
          />
        )}
        {variables.map((v) => (
          <Row
            key={v.key}
            label={v.label}
            mono
            value={
              v.value === null
                ? 'not found'
                : v.kind === 'secret' && !reveal
                  ? MASK
                  : v.value
            }
            copy={v.value}
            hint={
              v.value === null
                ? 'It was set when the project was deployed and can no longer be read.'
                : v.where
                  ? `Stored in ${v.where}.`
                  : undefined
            }
          />
        ))}
        {!template.publicWeb && (
          <p className="pt-3 text-xs text-muted-foreground">
            In another app, put the connection string in a secret and read it
            from there instead of pasting it into its environment.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
