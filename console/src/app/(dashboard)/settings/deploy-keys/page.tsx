import { SettingsHeader } from '@/components/settings-header';
import { getApps } from '@/lib/app-data';
import { loadApiKeys } from '@/lib/backend';
import { env } from '@/lib/env';
import { withSession } from '@/lib/with-session';
import { ApiKeyList } from '../access/api-key-list';
import { CreateKeyForm } from '../access/create-key-form';

export const dynamic = 'force-dynamic';

export default async function DeployKeysPage() {
  const [keys, { appDefinitions }] = await Promise.all([
    withSession(loadApiKeys),
    getApps(),
  ]);
  const apiUrl = env().PROVELOX_PUBLIC_API_URL ?? env().PROVELOX_API_URL;
  return (
    <>
      <SettingsHeader
        title="Deploy keys"
        description="For CI: a key that can deploy one app and nothing else. An app's own Deployments tab makes and lists its keys too."
      />
      <CreateKeyForm
        apps={appDefinitions.map((a) => a.appName).sort()}
        apiUrl={apiUrl}
      />
      <ApiKeyList keys={keys} />
    </>
  );
}
