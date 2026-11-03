import { Activity, Globe, Package } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getApp } from '@/lib/app-data';
import { loadImageUpdates } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { UpgradeBadge } from '@/components/apps/upgrade-badge';
import { timeAgo } from '@/lib/format';
import { siteUrl } from '@/lib/site-url';
import { summarizeRuntime } from '@/lib/runtime-settings';
import { appDomains } from '@/lib/types';
import { AppStatusBadge, appStatus } from './app-status-badge';
import { ConfigLink, Facts, StatTile } from './overview-parts';
import { SettingsForm } from './settings-form';
import { UsageTile } from './usage-tile';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const [{ app, rootDomain, ports, projectApps }, updates] = await Promise.all([
    getApp(name),
    withSession(loadImageUpdates),
  ]);
  const newer = updates[app.appName];
  const base = `/apps/${app.appName}`;
  const domains = appDomains(app, rootDomain);
  const primary = domains[0];
  const latest = [...app.versions].reverse().find((v) => v.deployedImageName);
  const image = app.image || latest?.deployedImageName || '';
  const recent = [...app.versions].reverse().slice(0, 5);
  const status = appStatus(app);
  const instances = app.runStatus
    ? `${app.runStatus.running} of ${app.runStatus.desired} running`
    : `${app.instanceCount} wanted`;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Status"
          icon={Activity}
          tone={
            status === 'running'
              ? 'good'
              : status === 'failed' || status === 'unhealthy'
                ? 'bad'
                : status === 'starting' || status === 'building'
                  ? 'warn'
                  : 'neutral'
          }
          detail={
            app.runStatus?.message ??
            (status === 'stopped'
              ? 'No instances wanted'
              : status === 'unhealthy'
                ? `${instances}, but its health check is failing`
                : instances)
          }
        >
          <AppStatusBadge app={app} />
        </StatTile>
        <StatTile
          label="Image"
          icon={Package}
          detail={
            latest
              ? `Version ${app.deployedVersion}, deployed ${timeAgo(latest.timeStamp)}`
              : image
                ? app.project
                  ? `Deployed with the project ${app.project}`
                  : 'Deployed'
                : 'Nothing deployed yet'
          }
        >
          <span className="flex items-center gap-2">
            <span className="block truncate font-mono text-sm" title={image}>
              {image || 'None'}
            </span>
            <UpgradeBadge
              app={app.appName}
              image={image}
              update={newer}
              persistent={app.volumes.length > 0}
              project={app.project}
            />
          </span>
        </StatTile>
        <StatTile
          label="Address"
          icon={Globe}
          detail={
            domains.length > 1 ? (
              <Link
                href={`${base}/networking#domains`}
                className="hover:underline"
              >
                and {domains.length - 1} more
              </Link>
            ) : primary ? (
              primary.ssl ? (
                'HTTPS'
              ) : (
                'HTTP only'
              )
            ) : app.notExposeAsWebApp ? (
              <Link href={`${base}/networking#web`} className="hover:underline">
                {app.ports.length > 0
                  ? `${app.ports.length} published ${app.ports.length === 1 ? 'port' : 'ports'}`
                  : 'No published ports'}
              </Link>
            ) : (
              <Link
                href={`${base}/networking#internal`}
                className="font-mono hover:underline"
              >
                {app.appName}:{app.containerHttpPort ?? 80} inside the instance
              </Link>
            )
          }
        >
          {primary ? (
            <a
              href={siteUrl(primary, ports)}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-sm hover:underline"
            >
              {primary.host}
            </a>
          ) : app.notExposeAsWebApp ? (
            app.linkedDomain ? (
              <span
                className="block truncate font-mono text-sm"
                title="Linked for identification; not served over HTTP"
              >
                {app.linkedDomain}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                Not a web app
              </span>
            )
          ) : (
            <span className="text-sm text-muted-foreground">Internal only</span>
          )}
        </StatTile>
        <UsageTile appName={app.appName} running={status === 'running'} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="flex flex-col gap-5 lg:col-span-2">
          <SettingsForm app={app} />
          <Card>
            <CardHeader className="flex-col items-start sm:flex-row sm:items-center justify-between">
              <CardTitle>Recent deployments</CardTitle>
              <Link
                href={`${base}/deploy`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                All deployments
              </Link>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {app.project ? (
                    <>
                      Deployed as part of the project{' '}
                      <Link
                        href={`/projects/${app.project}`}
                        className="underline underline-offset-2"
                      >
                        {app.project}
                      </Link>
                      . Update the project to change it.
                    </>
                  ) : (
                    <>
                      Nothing deployed yet.{' '}
                      <Link
                        href={`${base}/deploy`}
                        className="underline underline-offset-2"
                      >
                        Deploy an image
                      </Link>
                    </>
                  )}
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {recent.map((v) => (
                    <li
                      key={v.version}
                      className="flex items-center justify-between gap-4 py-2"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">
                          v{v.version}
                        </span>
                        <span className="truncate font-mono text-xs">
                          {v.deployedImageName || '(placeholder)'}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {timeAgo(v.timeStamp)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Facts
            title="Details"
            rows={[
              {
                label: 'Docker service',
                value: `pvx-${app.appName}`,
                mono: true,
              },
              {
                label: 'Reached on the network as',
                value: [app.appName, ...(app.aliases ?? [])].join(', '),
                mono: true,
              },
              ...(app.project
                ? [
                    {
                      label: 'Project',
                      value: (
                        <Link
                          href={`/projects/${app.project}`}
                          className="underline underline-offset-2"
                        >
                          {app.project}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...summarizeRuntime(app.runtime).map((r) => ({
                label: r.label,
                value: r.value,
              })),
              {
                label: 'Data',
                value: app.hasPersistentData ? 'Persistent' : 'Stateless',
              },
              ...(app.createdAt
                ? [{ label: 'Created', value: timeAgo(app.createdAt) }]
                : []),
            ]}
          />
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col p-2 pt-0">
              <ConfigLink
                href={`${base}/configuration#environment`}
                label="Environment"
                hint="Variables"
                count={app.envVars.length}
              />
              <ConfigLink
                href={`${base}/configuration#secrets`}
                label="Secrets"
                hint="Mounted under /run/secrets"
                count={app.secrets?.length ?? 0}
              />
              <ConfigLink
                href={`${base}/configuration#storage`}
                label="Storage"
                hint="Volumes and directories"
                count={app.volumes.length}
              />
              <ConfigLink
                href={`${base}/networking#ports`}
                label="Published ports"
                hint="On the server"
                count={app.ports.length}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
