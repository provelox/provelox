import { SettingsHeader } from '@/components/settings-header';
import { loadPlatformServices } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { PlatformServicesCard } from '../infrastructure/platform-services-card';

export const dynamic = 'force-dynamic';

export default async function PlatformServicesPage() {
  const platform = await withSession(loadPlatformServices);
  return (
    <>
      <SettingsHeader
        title="Platform services"
        description="The proxy, the API and the console: what Provelox itself runs on."
      />
      <PlatformServicesCard initial={platform} />
    </>
  );
}
