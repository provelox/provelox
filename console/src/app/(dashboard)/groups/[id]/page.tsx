import { redirect } from 'next/navigation';

/** Collections used to be called groups: old links and bookmarks land on the new address. */
export default async function MovedGroup({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  redirect(`/collections/${(await params).id}`);
}
