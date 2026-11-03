import { HashRedirect } from '@/components/hash-redirect';

/** Infrastructure is one page per topic now. The "keep versions" choice travels with a storage link. */
export default async function Moved({
  searchParams,
}: {
  searchParams: Promise<{ keep?: string }>;
}) {
  const { keep } = await searchParams;
  return (
    <HashRedirect
      fallback="/settings/servers"
      map={{
        servers: '/settings/servers',
        platform: '/settings/platform-services',
        storage: '/settings/storage',
        connection: '/settings/connection',
      }}
      keep={keep ? `?keep=${encodeURIComponent(keep)}` : undefined}
    />
  );
}
