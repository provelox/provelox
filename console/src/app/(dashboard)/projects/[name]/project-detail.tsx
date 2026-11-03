'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Clock,
  Cpu,
  ExternalLink,
  FileCode2,
  Globe,
  Layers,
  Loader2,
  MoreHorizontal,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { restartAppAction } from '@/actions/apps';
import { Section, SectionNav } from '@/components/section-nav';
import { ConnectionCard } from '@/components/projects/connection-card';
import { AppsCollection } from '@/components/apps/apps-collection';
import { AddToProject, notesOf } from '@/components/projects/add-to-project';
import { modeFor } from '@/components/projects/group-apps';
import { Breadcrumbs } from '@/components/breadcrumbs';
import type { AppRow } from '@/app/(dashboard)/apps/app-row';
import { LogsViewer } from '@/app/(dashboard)/apps/[name]/logs/logs-viewer';
import { Combobox } from '@/components/ui/combobox';
import { RemoveProjectDialog } from '@/components/projects/remove-project-dialog';
import {
  DeployProjectDialog,
  type DeployMode,
} from '@/components/projects/deploy-project-dialog';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { KpiBar } from '@/components/ui/kpi';
import { StatTile } from '@/app/(dashboard)/apps/[name]/overview-parts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { UsageByApp } from '@/lib/backend';
import { formatBytes } from '@/lib/format';
import { apiGet } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import type { ProjectDetail, ProjectService } from '@/lib/types';

const VARIANT = {
  running: 'success',
  starting: 'warning',
  failed: 'destructive',
  stopped: 'default',
  unknown: 'default',
} as const;

/** The values read back from the running services: what an update starts from, so nothing has to be typed again */
const runningValues = (variables: { key: string; value: string | null }[]) =>
  Object.fromEntries(
    variables.flatMap((v) => (v.value === null ? [] : [[v.key, v.value]])),
  );

export function ProjectDetailView({
  project,
  rows,
}: {
  project: ProjectDetail;
  rows: AppRow[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<DeployMode | null>(null);
  const [removing, setRemoving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [logApp, setLogApp] = useState<string | null>(null);
  const [restartPending, startRestart] = useTransition();

  // Keep statuses fresh while the page is open
  const status = useQuery({
    queryKey: ['project-status', project.name],
    queryFn: () =>
      apiGet<{ services: ProjectService[] }>(`project-status/${project.name}`),
    refetchInterval: 5000,
    initialData: { services: project.services },
  });
  const services = status.data.services;
  // What each service uses now, shared with the apps list (same readings, refreshed while the page is open)
  const usage = useQuery({
    queryKey: ['usage-all'],
    queryFn: () => apiGet<UsageByApp>('usage'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const read = services
    .map((s) => usage.data?.[s.app])
    .filter((u): u is NonNullable<typeof u> => !!u);
  const totalCpu = read.reduce((n, u) => n + u.cpuPercent, 0);
  const totalMem = read.reduce((n, u) => n + u.memoryBytes, 0);
  const running = services.filter((s) => s.desired > 0);
  const runningNow = services.filter((s) => s.state === 'running').length;
  const stopped = services.filter((s) => s.desired === 0).length;
  const failing = services.some((s) => s.state === 'failed');
  const health = failing
    ? {
        label: 'Failing',
        variant: 'destructive' as const,
        tone: 'bad' as const,
      }
    : runningNow === services.length && services.length > 0
      ? { label: 'Running', variant: 'success' as const, tone: 'good' as const }
      : runningNow === 0
        ? {
            label: 'Stopped',
            variant: 'default' as const,
            tone: 'neutral' as const,
          }
        : {
            label: 'Partly running',
            variant: 'warning' as const,
            tone: 'warn' as const,
          };
  const publicHosts = rows.flatMap((r) => r.domains);
  const byApp = new Map(services.map((s) => [s.app, s]));
  // Which service's logs are shown: the one asked for, or the first
  const logService = services.find((s) => s.app === logApp) ?? services[0];

  function restartAll() {
    startRestart(async () => {
      const results = await Promise.all(
        running.map((s) => restartAppAction(s.app)),
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length)
        toast.error(
          `${failed.length} of ${results.length} could not be restarted: ${failed[0].ok ? '' : failed[0].error}`,
        );
      else toast.success(`Restarting ${project.name}`);
      setRestarting(false);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Breadcrumbs
          items={[{ label: 'Apps', href: '/apps' }, { label: project.name }]}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{project.name}</h1>
            <Badge variant={health.variant}>{health.label}</Badge>
            {project.template && (
              <span className="text-xs text-muted-foreground">
                from the {project.template.name} template
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={running.length === 0}
              title={running.length === 0 ? 'Nothing is running' : undefined}
              onClick={() => setRestarting(true)}
            >
              <RotateCw className="h-4 w-4" /> Restart
            </Button>
            <AddToProject
              project={project.name}
              existingServices={services.map((s) => s.service)}
              onMerged={(m) =>
                setMode({
                  kind: 'update',
                  project: project.name,
                  compose: m.compose,
                  values: { ...runningValues(project.variables), ...m.values },
                  notes: notesOf(m),
                })
              }
              onGrouped={(g) =>
                setMode(
                  modeFor(project.name, g, runningValues(project.variables)),
                )
              }
            />
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  onSelect={() =>
                    setMode({
                      kind: 'update',
                      project: project.name,
                      compose: project.compose,
                      values: runningValues(project.variables),
                    })
                  }
                >
                  <FileCode2 className="h-4 w-4" /> Edit the compose file…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setRemoving(true)}
                >
                  <Trash2 className="h-4 w-4" /> Remove project…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Services"
          icon={Layers}
          tone={health.tone}
          detail={
            health.tone === 'bad'
              ? 'one or more is failing'
              : stopped
                ? `${stopped} stopped`
                : 'all running'
          }
        >
          {runningNow} of {services.length} running
        </StatTile>
        <StatTile
          label="In use now"
          icon={Cpu}
          tone="info"
          detail={
            read.length ? 'the whole project, added up' : 'no reading yet'
          }
        >
          {read.length ? (
            <span className="flex flex-col gap-1.5">
              <span className="tabular-nums">
                {totalCpu.toFixed(totalCpu < 10 ? 1 : 0)}% ·{' '}
                {formatBytes(totalMem)}
              </span>
              <KpiBar value={Math.min(100, totalCpu)} tone="info" />
            </span>
          ) : (
            '–'
          )}
        </StatTile>
        <StatTile
          label="Address"
          icon={Globe}
          detail={
            publicHosts.length > 1
              ? `and ${publicHosts.length - 1} more`
              : publicHosts.length
                ? undefined
                : 'only the project’s own services can reach it'
          }
        >
          {publicHosts[0] ? (
            <a
              href={publicHosts[0].url}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-sm hover:underline"
            >
              {publicHosts[0].host}
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">Private</span>
          )}
        </StatTile>
        <StatTile
          label="Updated"
          icon={Clock}
          detail={`${services.length} service${services.length === 1 ? '' : 's'} in the compose file`}
        >
          {timeAgo(project.updatedAt)}
        </StatTile>
      </div>

      <div className="lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-8">
        <aside className="hidden lg:block">
          <SectionNav
            sections={[
              { id: 'services', label: 'Services', count: services.length },
              ...(project.template
                ? [{ id: 'connection', label: 'Connection' }]
                : []),
              ...(logService ? [{ id: 'logs', label: 'Logs' }] : []),
              { id: 'compose', label: 'Compose file' },
            ]}
          />
        </aside>
        <div className="flex min-w-0 flex-col gap-6">
          <Section id="services">
            <AppsCollection
              rows={rows}
              noun="service"
              nameOf={(r) => byApp.get(r.name)?.service ?? r.name}
              subtitleOf={(r) => byApp.get(r.name)?.image}
            />
          </Section>

          {project.template && (
            <Section id="connection">
              <ConnectionCard template={project.template} />
            </Section>
          )}

          {logService && (
            <Section id="logs">
              <Card>
                <CardHeader className="flex-col items-start sm:flex-row sm:items-center justify-between gap-3">
                  <CardTitle className="text-base">Logs</CardTitle>
                  <Combobox
                    value={logService.app}
                    onValueChange={setLogApp}
                    className="w-56"
                    aria-label="Service"
                    options={services.map((s) => ({
                      value: s.app,
                      label: s.service,
                    }))}
                  />
                </CardHeader>
                <CardContent>
                  {/* keyed so switching service starts a fresh stream */}
                  <LogsViewer key={logService.app} appName={logService.app} />
                </CardContent>
              </Card>
            </Section>
          )}

          <Section id="compose">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Compose file</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <pre className="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs">
                  {project.compose}
                </pre>
                {project.variableNames.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Variables used: {project.variableNames.join(', ')}.{' '}
                    {project.template
                      ? 'Their values are read back from the services (see Connection).'
                      : 'Their values are not stored.'}
                  </p>
                )}
              </CardContent>
            </Card>
          </Section>
        </div>
      </div>

      <DeployProjectDialog
        mode={mode}
        existingProjects={[]}
        onClose={() => setMode(null)}
      />

      <AlertDialog
        open={restarting}
        onOpenChange={(o) => !restartPending && setRestarting(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All {running.length} running service
              {running.length === 1 ? '' : 's'} (
              {running.map((s) => s.service).join(', ')}) are replaced with
              fresh instances. Services that keep data stop for a moment first.
              Images and settings do not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restartPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={restartPending}
              onClick={(e) => {
                e.preventDefault();
                restartAll();
              }}
            >
              {restartPending && <Loader2 className="h-4 w-4 animate-spin" />}{' '}
              Restart project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RemoveProjectDialog
        project={project.name}
        services={services.map((x) => x.service)}
        open={removing}
        onOpenChange={setRemoving}
        onRemoved={() => router.push('/apps')}
      />
    </div>
  );
}
