import { SettingsHeader } from '@/components/settings-header';
import { loadSecurity } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { SecurityView } from './security-view';

export const dynamic = 'force-dynamic';

/**
 * Signs of a machine someone else controls. The page shows the last scan (the platform takes one shortly after it
 * starts and every half hour), and "Check now" takes a new one.
 */
export default async function SecurityChecksPage() {
  const scan = await withSession((t) => loadSecurity(t, 'cached'));
  return (
    <>
      <SettingsHeader
        title="Security checks"
        description="Looks for the signs of a break-in: databases open to the internet, a hidden miner, and what malware leaves on the machine."
      />
      <SecurityView initial={scan} />
    </>
  );
}
