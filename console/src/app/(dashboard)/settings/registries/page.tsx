import { SettingsHeader } from '@/components/settings-header';
import { loadRegistries } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { RegistriesPanel } from './registries-panel';

export const dynamic = 'force-dynamic';

export default async function RegistriesPage() {
  const registries = await withSession(loadRegistries);
  return (
    <>
      <SettingsHeader
        title="Image registries"
        description="Logins for the registries your private images come from, so apps can be deployed from them. For templates, see Template registries."
      />
      <RegistriesPanel
        key={JSON.stringify(registries)}
        registries={registries}
      />
    </>
  );
}
