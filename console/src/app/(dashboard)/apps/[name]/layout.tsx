import { AlertTriangle, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { getApp } from '@/lib/app-data';
import { loadGroups } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { groupOfApp } from '@/lib/groups';
import { siteUrl } from '@/lib/site-url';
import { appDomains } from '@/lib/types';
import { StatusWatcher } from '@/components/apps/status-watcher';
import { isTransitional } from '@/lib/app-watch';
import { AppStatusBadge, appStatus } from './app-status-badge';
import { AppRail } from './app-rail';
import { AppTabs } from './app-tabs';
import { PinButton } from '@/components/apps/pin-button';
import { appNav } from '@/lib/nav';
import { PowerButton } from '@/components/apps/power-button';
import { RestartButton } from '@/components/apps/restart-button';
import { GroupPicker } from './group-picker';
import { AppMenu } from './app-menu';
import { Breadcrumbs } from '@/components/breadcrumbs';

export const dynamic = 'force-dynamic';

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  // Independent calls, asked together
  const [{ app, rootDomain, ports, allApps, projectApps }, groups] =
    await Promise.all([getApp(name), withSession(loadGroups)]);
  const domains = appDomains(app, rootDomain);
  const group = groupOfApp(groups, app.appName);

  return (
    <div className="flex flex-col gap-5">
      <StatusWatcher active={isTransitional(appStatus(app))} />
      <div>
        <Breadcrumbs
          items={[
            { label: 'Apps', href: '/apps' },
            // a project's service sits under its project, an ordinary app under its group
            ...(app.project
              ? [{ label: app.project, href: `/projects/${app.project}` }]
              : group
                ? [{ label: group.name, href: `/collections/${group.id}` }]
                : []),
            { label: app.appName },
          ]}
        />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{app.appName}</h1>
          <PinButton appName={app.appName} />
          <AppStatusBadge app={app} />
          <Badge>v{app.deployedVersion}</Badge>
          {!app.project && (
            <GroupPicker
              appName={app.appName}
              groups={groups}
              groupId={group?.id ?? null}
            />
          )}
          <span className="ml-auto flex gap-2">
            <PowerButton
              appName={app.appName}
              running={app.instanceCount > 0}
              persistent={app.hasPersistentData}
            />
            <RestartButton
              appName={app.appName}
              persistent={app.hasPersistentData}
              disabledReason={
                app.instanceCount === 0
                  ? 'The app is stopped'
                  : !app.image
                    ? 'Nothing is deployed yet'
                    : undefined
              }
            />
            <AppMenu
              appName={app.appName}
              project={app.project}
              projectApps={projectApps}
              existingApps={allApps}
              facts={{
                domains: app.customDomain.length,
                defaultAddress: !app.disableDefaultSubDomain,
                secrets: app.secrets?.length ?? 0,
                volumes: app.volumes
                  .map((v) => v.volumeName)
                  .filter((v): v is string => !!v),
              }}
            />
          </span>
        </div>
        {domains.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {domains.map((d) => (
              <a
                key={d.host}
                href={siteUrl(d, ports)}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 hover:text-foreground hover:underline coarse:py-2"
              >
                {d.host} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </div>
      {!!app.missingSecrets?.length && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p>
            <span className="font-medium">{app.appName} cannot start.</span> Its{' '}
            {app.missingSecrets.length === 1 ? 'secret' : 'secrets'}{' '}
            <code>{app.missingSecrets.join(', ')}</code>{' '}
            {app.missingSecrets.length === 1 ? 'is' : 'are'} no longer in Docker
            (a rebuilt Swarm loses them). Set{' '}
            {app.missingSecrets.length === 1 ? 'it' : 'them'} again, or delete{' '}
            {app.missingSecrets.length === 1 ? 'it' : 'them'} if the app does
            not need {app.missingSecrets.length === 1 ? 'it' : 'them'}, in the{' '}
            <Link
              href={`/apps/${app.appName}/configuration#secrets`}
              className="underline underline-offset-2"
            >
              Secrets section
            </Link>
            .
          </p>
        </div>
      )}
      {/* the tabs are for narrow screens; wide ones have the rail */}
      <div className="lg:hidden">
        <AppTabs name={app.appName} />
      </div>
      <div className="lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-8">
        <aside className="hidden lg:block">
          <AppRail
            name={app.appName}
            items={appNav({
              env: app.envVars.length,
              secrets: app.secrets?.length ?? 0,
              volumes: app.volumes.length,
              domains:
                app.customDomain.length + (app.disableDefaultSubDomain ? 0 : 1),
              ports: app.ports.length + (app.pendingPorts?.length ?? 0),
            })}
          />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
