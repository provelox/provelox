import { notFound } from 'next/navigation';
import { toRow } from '@/app/(dashboard)/apps/app-row';
import { getApps } from '@/lib/app-data';
import { BackendError, loadImageUpdates, loadProject } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { ProjectDetailView } from './project-detail';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  try {
    const [project, data, updates] = await withSession((t) =>
      Promise.all([loadProject(t, name), getApps(), loadImageUpdates(t)]),
    );
    const rows = data.appDefinitions
      .filter((a) => a.project === name)
      .map((a) => ({
        ...toRow(a, data.rootDomain, data.ports),
        update: updates[a.appName],
      }));
    return <ProjectDetailView project={project} rows={rows} />;
  } catch (e) {
    if (e instanceof BackendError && e.status === 404) notFound();
    throw e;
  }
}
