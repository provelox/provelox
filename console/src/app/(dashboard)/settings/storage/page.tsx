import { SettingsHeader } from '@/components/settings-header';
import { loadStorageReport } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { StoragePanel } from '../infrastructure/storage-panel';

export const dynamic = 'force-dynamic';

export default async function StoragePage({
  searchParams,
}: {
  searchParams: Promise<{ keep?: string }>;
}) {
  const { keep } = await searchParams;
  const keepVersions = Math.min(
    Math.max(Number.parseInt(keep ?? '1', 10) || 0, 0),
    10,
  );
  const report = await withSession((token) =>
    loadStorageReport(token, keepVersions),
  );
  return (
    <>
      <SettingsHeader
        title="Storage & cleanup"
        description="What is using the disk, and what can safely go."
      />
      <StoragePanel
        key={`${keepVersions}:${report.volumes.length}:${report.images.length}`}
        report={report}
      />
    </>
  );
}
