'use client';

import { WaitingScreen } from '@/components/waiting-screen';

/** An unexpected failure inside the console's frame: say whether the API is the reason, and wait if it is. */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <WaitingScreen
      variant="error"
      compact
      digest={error.digest}
      reset={reset}
    />
  );
}
