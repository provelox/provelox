import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/app-shell';
import { WaitingScreen } from '@/components/waiting-screen';
import { isApiDown } from '@/lib/availability';
import { getApps } from '@/lib/app-data';
import { loadGroups } from '@/lib/backend';
import { statusOf } from '@/app/(dashboard)/apps/app-row';
import { groupOfApp } from '@/lib/groups';
import { getSession } from '@/lib/session';
import { withSessionOr } from '@/lib/with-session';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Real URLs + a server-side session check: a refresh keeps you signed in,
  // and an expired session redirects to /login instead of rendering a broken page.
  const session = await getSession();
  if (!session) redirect('/login');
  // The first call also notices a dead token (password changed, API reinstalled): sign out cleanly
  let loaded;
  try {
    loaded = await getApps();
  } catch (e) {
    // Not answering is what an update or a restart looks like: wait for it rather than show an error
    if (isApiDown(e)) return <WaitingScreen />;
    throw e;
  }
  const { appDefinitions, version } = loaded;
  // Collection names feed the command palette; without them it just lists apps
  const groups = await withSessionOr(loadGroups, { groups: [] });
  const apps = appDefinitions
    .map((a) => ({
      name: a.appName,
      group: groupOfApp(groups, a.appName)?.name,
      project: a.project,
      state: statusOf({
        building: !!a.isAppBuilding,
        instanceCount: a.instanceCount,
        runState: a.runState,
        health: a.runStatus?.health,
      }) as string,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AppShell
      apps={apps}
      groups={groups.groups.map(({ id, name }) => ({ id, name }))}
      version={version}
    >
      {children}
    </AppShell>
  );
}
