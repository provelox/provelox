import { redirect } from 'next/navigation';

/** These settings moved: old links and bookmarks land on their new place. */
export default async function Moved({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  redirect(`/apps/${name}/configuration#environment`);
}
