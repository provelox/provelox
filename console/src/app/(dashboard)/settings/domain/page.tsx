import { SettingsHeader } from '@/components/settings-header';
import { loadPlatformHosts, loadSystemInfo } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { DomainPanel } from '../general/domain-panel';

export const dynamic = 'force-dynamic';

export default async function DomainPage() {
  const [info, platformHosts] = await Promise.all([
    withSession(loadSystemInfo),
    withSession(loadPlatformHosts),
  ]);
  return (
    <>
      <SettingsHeader
        title="Domain & HTTPS"
        description="Where your apps are served, and the email Let’s Encrypt uses for their certificates."
      />
      <DomainPanel
        platformHosts={platformHosts}
        info={{
          rootDomain: info.rootDomain,
          appsDomain: info.appsDomain,
          appsDomainCustom: info.appsDomainCustom,
          acmeEmail: info.acmeEmail,
          defaultSubdomainForNewApps: info.defaultSubdomainForNewApps,
        }}
      />
    </>
  );
}
