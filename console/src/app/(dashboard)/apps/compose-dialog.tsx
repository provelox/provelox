'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEver } from '@/lib/use-ever';

// Fetched the first time it is asked for, not with the list
const DeployProjectDialog = dynamic(
  () =>
    import('@/components/projects/deploy-project-dialog').then(
      (m) => m.DeployProjectDialog,
    ),
  { ssr: false },
);

/** The "paste a compose file" dialog, open while the address has ?compose=1 (the New menu links there). */
export function ComposeProjectDialog({
  existingProjects,
}: {
  existingProjects: string[];
}) {
  const router = useRouter();
  const open = useSearchParams().get('compose') === '1';
  const wanted = useEver(open);
  if (!wanted) return null;
  return (
    <DeployProjectDialog
      mode={open ? { kind: 'custom' } : null}
      existingProjects={existingProjects}
      onClose={() => router.replace('/apps')}
    />
  );
}
