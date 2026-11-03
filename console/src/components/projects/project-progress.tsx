'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { apiGet } from '@/lib/client-api';
import type { ProjectService } from '@/lib/types';

export type ProjectPhase = 'waiting' | 'starting' | 'running' | 'failed';

/**
 * Where a project is, from its services. Failure wins (no point waiting for the rest), and nothing counts as running
 * until every service does. An empty list means the API has not reported the services yet.
 */
export function projectPhase(
  services: Pick<ProjectService, 'state'>[] | undefined,
): ProjectPhase {
  if (!services || services.length === 0) return 'waiting';
  if (services.some((s) => s.state === 'failed')) return 'failed';
  return services.every((s) => s.state === 'running') ? 'running' : 'starting';
}

/** Follows a project's services until they run (or one fails). Closing the window only stops watching. */
export function ProjectProgress({ project }: { project: string }) {
  const q = useQuery({
    queryKey: ['project-status', project],
    queryFn: () =>
      apiGet<{ services: ProjectService[] }>(`project-status/${project}`),
    refetchInterval: (query) => {
      const p = projectPhase(query.state.data?.services);
      return p === 'running' || p === 'failed' ? false : 2000;
    },
  });
  const services = q.data?.services ?? [];
  const phase = projectPhase(services);

  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      aria-live="polite"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {phase === 'running' ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> All services
            are running
          </>
        ) : phase === 'failed' ? (
          <>
            <XCircle className="h-4 w-4 text-destructive" /> A service is not
            starting
          </>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Starting
            services…
          </>
        )}
      </p>
      <ul className="divide-y text-sm">
        {services.map((s) => (
          <li
            key={s.app}
            className="flex items-center justify-between gap-3 py-1.5"
          >
            <span className="flex items-center gap-2">
              {s.state === 'running' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : s.state === 'failed' ? (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
              <span className="font-mono text-xs">{s.service}</span>
            </span>
            <span className="flex items-center gap-3 text-xs text-muted-foreground">
              {s.state === 'running' && s.host && (
                <a
                  href={`${s.host.ssl ? 'https' : 'http'}://${s.host.host}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  {s.host.host} <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {s.running}/{s.desired}
            </span>
          </li>
        ))}
        {services.length === 0 && (
          <li className="py-1.5 text-xs text-muted-foreground">
            Waiting for the services to appear…
          </li>
        )}
      </ul>
      {phase !== 'running' && phase !== 'failed' && (
        <p className="text-xs text-muted-foreground">
          You can close this window: the services keep starting in the
          background.
        </p>
      )}
    </div>
  );
}
