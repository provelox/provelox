import { redirect } from 'next/navigation';

/** Projects are listed with the apps now. Old links (and the New menu's) land there. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  redirect((await searchParams).new === '1' ? '/apps?compose=1' : '/apps');
}
