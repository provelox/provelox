import { notFound } from 'next/navigation';
import { toRow } from '@/app/(dashboard)/apps/app-row';
import { getApps } from '@/lib/app-data';
import { loadGroups, loadImageUpdates } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { GroupView } from './group-view';

export const dynamic = 'force-dynamic';

export default async function GroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [data, groups, updates] = await withSession(async (token) =>
    Promise.all([getApps(), loadGroups(token), loadImageUpdates(token)]),
  );
  const group = groups.groups.find((g) => g.id === id);
  if (!group) notFound();
  const rows = data.appDefinitions
    .filter((a) => group.appNames.includes(a.appName))
    .map((a) => ({
      ...toRow(a, data.rootDomain, data.ports),
      update: updates[a.appName],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const candidates = data.appDefinitions
    .filter(
      (a) =>
        !a.project &&
        !groups.groups.some((g) => g.appNames.includes(a.appName)),
    )
    .map((a) => a.appName)
    .sort();
  return (
    <GroupView
      group={{ id: group.id, name: group.name }}
      rows={rows}
      groups={groups}
      candidates={candidates}
      allApps={data.appDefinitions.map((a) => a.appName)}
      rootDomain={data.rootDomain}
      defaultSubdomain={data.defaultSubdomainForNewApps}
    />
  );
}
