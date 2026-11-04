import { SettingsHeader } from '@/components/settings-header';
import { loadRelease } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { UpdatesView } from './updates-view';

export const dynamic = 'force-dynamic';

/**
 * Which release this server runs and whether a newer one exists. The platform looks now and then (it remembers the
 * answer for hours) and never installs anything by itself: the button here is the only way an update starts.
 */
export default async function UpdatesPage() {
  const status = await withSession((t) => loadRelease(t));
  return (
    <>
      <SettingsHeader
        title="Updates"
        description="Which Provelox release this server runs, and whether a newer one is out. Nothing is installed unless you press the button."
      />
      <UpdatesView initial={status} />
    </>
  );
}
