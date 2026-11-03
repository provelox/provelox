'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { PlatformService } from '@/lib/backend';
import { apiGet } from '@/lib/client-api';
import { formatBytes } from '@/lib/format';

const VARIANT = {
  running: 'success',
  starting: 'warning',
  failed: 'destructive',
  stopped: 'default',
} as const;

/** The services Provelox itself runs on: what state they are in and what they use now, refreshed while open. */
export function PlatformServicesCard({
  initial,
}: {
  initial: PlatformService[];
}) {
  const services = useQuery({
    queryKey: ['platform-services'],
    queryFn: () => apiGet<PlatformService[]>('platform-services'),
    initialData: initial,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform</CardTitle>
        <CardDescription>
          The services Provelox itself runs on. They are not apps: they do not
          appear in your app list and cannot be stopped or deleted from here.
          Upgrade them by running the install command again with a new image.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y text-sm">
        {services.data.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between gap-4 py-2.5"
          >
            <span className="min-w-0">
              <span className="font-medium">{p.label}</span>
              {p.image && (
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {p.image}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-4">
              {p.usage && (
                <span
                  className="tabular-nums text-xs text-muted-foreground"
                  title="CPU and memory now"
                >
                  {p.usage.cpuPercent.toFixed(p.usage.cpuPercent < 10 ? 1 : 0)}%
                  · {formatBytes(p.usage.memoryBytes)}
                </span>
              )}
              {p.installed && p.state ? (
                <Badge variant={VARIANT[p.state]}>{p.state}</Badge>
              ) : (
                <Badge>not installed</Badge>
              )}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
