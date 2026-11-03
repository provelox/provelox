import { SettingsHeader } from '@/components/settings-header';
import { loadPlaceholder } from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { PlaceholderEditor } from '../general/placeholder-editor';

export const dynamic = 'force-dynamic';

export default async function PlatformPagesPage() {
  const html = await withSession(loadPlaceholder);
  return (
    <>
      <SettingsHeader
        title="Platform pages"
        description="The page visitors see at an app that has nothing deployed yet."
      />
      <PlaceholderEditor initial={html} />
    </>
  );
}
