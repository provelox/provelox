import { SectionedPage } from '@/components/sectioned-page';
import { SettingsHeader } from '@/components/settings-header';
import { loadTemplateSources } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { TemplateRegistriesPanel } from './template-registries-panel';

export const dynamic = 'force-dynamic';

export default async function TemplateRegistriesPage() {
  const sources = await withSession(loadTemplateSources);
  return (
    <>
      <SettingsHeader
        title="Template registries"
        description="Offer your own templates next to the built-in ones, from a file you host or a git repository."
      />
      <SectionedPage
        sections={[
          { id: 'registries', label: 'Your registries', count: sources.length },
          { id: 'add', label: 'Add a registry' },
          { id: 'guide', label: 'Make your own' },
        ]}
      >
        <TemplateRegistriesPanel sources={sources} />
      </SectionedPage>
    </>
  );
}
