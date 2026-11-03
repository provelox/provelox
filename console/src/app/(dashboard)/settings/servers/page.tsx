import { SettingsHeader } from '@/components/settings-header';
import { loadCluster } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { ClusterCard } from '../infrastructure/cluster-card';

export const dynamic = 'force-dynamic';

export default async function ServersPage() {
  const cluster = await withSession(loadCluster);
  return (
    <>
      <SettingsHeader
        title="Servers"
        description="The machines apps run on. Add one to grow the cluster, or drain one before you work on it."
      />
      <ClusterCard cluster={cluster} />
    </>
  );
}
