import { SettingsHeader } from '@/components/settings-header';
import { loadNotifications } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { NotificationsPanel } from '../general/notifications-panel';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const notifications = await withSession(loadNotifications);
  return (
    <>
      <SettingsHeader
        title="Notifications"
        description="Be told when an app or a server has a problem, and when it recovers."
      />
      <NotificationsPanel
        key={JSON.stringify(notifications)}
        initial={notifications}
      />
    </>
  );
}
