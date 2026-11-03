import { getApp } from '@/lib/app-data';
import { Section } from '@/components/section-nav';
import { loadApiKeys } from '@/lib/backend';
import { env } from '@/lib/env';
import { withSession } from '@/lib/with-session';
import { ApiKeyList } from '../../../settings/access/api-key-list';
import { CreateKeyForm } from '../../../settings/access/create-key-form';
import { DeployPanel } from './deploy-panel';

export default async function DeployPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const [{ app }, allKeys] = await Promise.all([
    getApp(name),
    withSession(loadApiKeys),
  ]);
  const keys = allKeys.filter((k) => k.appName === app.appName);
  const apiUrl = env().PROVELOX_PUBLIC_API_URL ?? env().PROVELOX_API_URL;
  const last =
    [...app.versions].reverse().find((v) => v.deployedImageName)
      ?.deployedImageName ?? '';
  return (
    <div className="flex flex-col gap-5">
      <Section id="deploy">
        <DeployPanel
          appName={app.appName}
          lastImage={last}
          versions={[...app.versions].reverse().slice(0, 10)}
          currentVersion={app.deployedVersion}
        />
      </Section>
      <Section id="deploy-keys">
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
          <CreateKeyForm
            apps={[app.appName]}
            fixedApp={app.appName}
            apiUrl={apiUrl}
          />
          <ApiKeyList keys={keys} title="Deploy keys" showApp={false} />
        </div>
      </Section>
    </div>
  );
}
