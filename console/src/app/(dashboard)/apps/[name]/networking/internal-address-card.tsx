import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { internalAddresses } from '@/lib/internal-address';
import type { AppDefinition } from '@/lib/types';

function Row({
  label,
  url,
  note,
}: {
  label: string;
  url: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1.5 font-mono text-sm">
          {url}
        </code>
        <CopyButton value={url} />
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * How other containers on this instance reach the app. Always there: it works whether or not the app has a domain,
 * and is the way to connect apps to each other without sending traffic through the internet.
 */
export function InternalAddressCard({ app }: { app: AppDefinition }) {
  const a = internalAddresses(app);
  const [name, ...aliases] = a.shared;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Internal address</CardTitle>
        <CardDescription>
          How other apps on this instance connect to it, with or without a
          domain. It is not reachable from the internet this way, and needs no
          certificate.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Row
          label="From any app on this instance"
          url={`http://${name}:${a.port}`}
          note={
            aliases.length
              ? `Also by ${aliases.map((x) => `${x}:${a.port}`).join(', ')}.`
              : undefined
          }
        />
        {a.project && (
          <Row
            label={`From the other services of the project ${a.project.name}`}
            url={`http://${a.project.host}:${a.port}`}
          />
        )}
        <p className="text-xs text-muted-foreground">
          The port is the one Provelox has on record for what the app listens on
          inside its container ({a.port}). If it listens elsewhere, such as 5432
          for Postgres or 6379 for Redis, change{' '}
          <Link
            href={`/apps/${app.appName}`}
            className="underline underline-offset-2"
          >
            Container HTTP port
          </Link>{' '}
          on the Overview tab. Replace <code>http</code> with whatever the app
          speaks, such as <code>postgres</code> or <code>redis</code>.
        </p>
      </CardContent>
    </Card>
  );
}
