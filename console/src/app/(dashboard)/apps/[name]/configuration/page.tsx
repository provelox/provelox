import { getApp } from '@/lib/app-data';
import {
  loadAppMounts,
  loadCluster,
  loadDatabaseInfo,
  loadVolumeMigration,
} from '@/lib/backend';
import { looksLikeDatabase } from '@/lib/volume-download';
import { appNav } from '@/lib/nav';
import { withSession } from '@/lib/with-session';
import { Section } from '@/components/section-nav';
import { SectionedPage } from '@/components/sectioned-page';
import { DatabasePanel } from './database-panel';
import { EnvEditor } from './env-editor';
import { PlacementCard } from './placement-card';
import { RuntimeForm } from './runtime-form';
import { SecretsPanel } from './secrets-panel';
import { StoragePanel } from './storage-panel';

export const dynamic = 'force-dynamic';

export default async function ConfigurationPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const { app } = await getApp(name);
  const [{ mounts, detected }, migration, cluster, database] =
    await withSession((token) =>
      Promise.all([
        loadAppMounts(token, app.appName, false),
        loadVolumeMigration(token, app.appName),
        // Only to offer the servers to choose from: without them the card says there is nothing to choose
        loadCluster(token).catch(() => null),
        // Only an app that looks like a database is asked, and only when it runs: the answer starts a process inside it
        app.instanceCount > 0 && looksLikeDatabase(app.image)
          ? loadDatabaseInfo(token, app.appName)
          : null,
      ]),
    );
  return (
    <SectionedPage
      aside={false}
      sections={
        appNav().find((p) => p.href === '/configuration')?.sections ?? []
      }
    >
      <Section id="environment">
        <EnvEditor appName={app.appName} initial={app.envVars} />
      </Section>
      <Section id="secrets">
        <SecretsPanel
          appName={app.appName}
          secrets={app.secrets ?? []}
          missing={app.missingSecrets ?? []}
        />
      </Section>
      <Section id="storage">
        {/* Keyed so the panel starts fresh whenever the saved mounts change */}
        <StoragePanel
          key={JSON.stringify(app.volumes)}
          appName={app.appName}
          mounts={mounts}
          detected={detected}
          migration={migration}
          volumes={app.volumes}
          persistent={app.hasPersistentData}
          image={app.image}
          running={app.instanceCount > 0}
        />
        {database?.engine && (
          <div className="mt-4">
            <DatabasePanel appName={app.appName} info={database} />
          </div>
        )}
      </Section>
      <Section id="runtime">
        <RuntimeForm
          key={JSON.stringify(app.runtime)}
          appName={app.appName}
          initial={app.runtime ?? { restart: 'any' }}
        />
      </Section>
      <Section id="placement">
        <PlacementCard
          key={JSON.stringify([app.placement, app.pinnedTo])}
          appName={app.appName}
          placement={app.placement}
          pinnedTo={app.pinnedTo ?? null}
          nodes={cluster?.managed ? cluster.nodes : []}
        />
      </Section>
    </SectionedPage>
  );
}
