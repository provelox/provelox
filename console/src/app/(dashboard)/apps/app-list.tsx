import { loadGroups, loadImageUpdates, loadNodes } from '@/lib/backend';
import { getApps } from '@/lib/app-data';
import { withSession } from '@/lib/with-session';
import { toRow } from './app-row';
import { AppsBrowser } from './apps-browser';
import { ComposeProjectDialog } from './compose-dialog';

export async function AppList() {
  let data;
  try {
    data = await getApps();
  } catch (e) {
    return (
      <p className="text-sm text-destructive">
        {e instanceof Error ? e.message : 'Failed to load apps'}
      </p>
    );
  }

  // What the machines have, to say what the apps use as a share of it; the list works without it
  const nodes = await withSession(loadNodes).catch(() => []);
  const ready = nodes.filter((n) => n.state === 'ready');
  const capacity = ready.length
    ? {
        cpus: ready.reduce((n, m) => n + m.cpus, 0),
        memoryBytes: ready.reduce((n, m) => n + m.memoryBytes, 0),
      }
    : undefined;
  const updates = await withSession(loadImageUpdates);
  const rows = data.appDefinitions
    .map((a) => ({
      ...toRow(a, data.rootDomain, data.ports),
      update: updates[a.appName],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <AppsBrowser
        rows={rows}
        groups={await withSession(loadGroups)}
        rootDomain={data.rootDomain}
        capacity={capacity}
        defaultSubdomain={data.defaultSubdomainForNewApps}
      />
      <ComposeProjectDialog
        existingProjects={[
          ...new Set(rows.flatMap((r) => (r.project ? [r.project] : []))),
        ]}
      />
    </>
  );
}
