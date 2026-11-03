import { redirect } from 'next/navigation';

/** The wizard is a modal on the apps page now; keep old links working. */
export default async function NewAppPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string }>;
}) {
  const { group } = await searchParams;
  redirect(
    group ? `/apps?new=1&group=${encodeURIComponent(group)}` : '/apps?new=1',
  );
}
