import { getApps } from '@/lib/app-data';
import { loadApiKeys, loadSystemInfo } from '@/lib/backend';
import { buildChecklist } from '@/lib/first-run';
import { withSession } from '@/lib/with-session';
import { FirstRunCard } from './first-run-card';

/**
 * The first-run checklist, worked out from what the platform really has. If anything cannot be read it shows nothing
 * rather than a checklist that might be wrong; the Apps list below says what is wrong with the connection.
 */
export async function FirstRun() {
  try {
    const [system, apps, keys] = await Promise.all([
      withSession(loadSystemInfo),
      getApps(),
      withSession(loadApiKeys),
    ]);
    const steps = buildChecklist({
      rootDomain: system.rootDomain,
      acmeEmail: system.acmeEmail,
      apps: apps.appDefinitions.map((a) => ({
        name: a.appName,
        deployed: !!a.image || (a.versions?.length ?? 0) > 0,
      })),
      deployKeys: keys.length,
    });
    return <FirstRunCard steps={steps} appCount={apps.appDefinitions.length} />;
  } catch (e) {
    // a rejected session still has to sign out cleanly (redirect errors are not failures)
    if ((e as { digest?: string } | null)?.digest?.startsWith('NEXT_')) throw e;
    return null;
  }
}
