import { SettingsHeader } from '@/components/settings-header';
import { filtersFrom } from '@/lib/activity';
import { getApps } from '@/lib/app-data';
import { loadActivity } from '@/lib/backend';
import { withSession, withSessionOr } from '@/lib/with-session';
import { ActivityView } from './activity-view';

export const dynamic = 'force-dynamic';

/** Who changed what, and when. Filters live in the address, so a link to an app's changes can be shared or bookmarked. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = filtersFrom(await searchParams);
  const [page, apps] = await Promise.all([
    withSession((t) => loadActivity(t, filters)),
    withSessionOr(
      async () => (await getApps()).appDefinitions.map((a) => a.appName),
      [] as string[],
    ),
  ]);
  return (
    <>
      <SettingsHeader
        title="Activity"
        description="Every change made through the console, the API or a deploy key: who did it, what it was, and whether it worked. Values of variables and secrets are never recorded."
      />
      <ActivityView
        // a new set of filters is a new list: nothing of the old one is kept
        key={JSON.stringify(filters)}
        initial={page}
        filters={filters}
        apps={apps.sort()}
      />
    </>
  );
}
