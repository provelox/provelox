import { Suspense } from 'react';
import { FirstRun } from '@/components/apps/first-run';
import { SecurityBanner } from '@/components/security-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { AppList } from './app-list';
import { NewMenu } from './new-menu';

export const dynamic = 'force-dynamic';

export default function AppsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Apps</h1>
        <NewMenu />
      </div>
      <Suspense fallback={null}>
        <FirstRun />
      </Suspense>
      <Suspense fallback={null}>
        <SecurityBanner />
      </Suspense>
      {/* The shell renders immediately; the list streams in once Provelox answers */}
      <Suspense
        fallback={
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        }
      >
        <AppList />
      </Suspense>
    </div>
  );
}
