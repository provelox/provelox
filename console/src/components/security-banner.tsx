import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { loadSecurity } from '@/lib/backend';
import { hasCritical } from '@/lib/security';
import { withSessionOr } from '@/lib/with-session';

/**
 * A short alert on the Apps page when the security check has found something critical. It only reads the last scan:
 * opening the page never starts one. Says nothing when all is well, and nothing when the check cannot be read.
 */
export async function SecurityBanner() {
  const scan = await withSessionOr((t) => loadSecurity(t, 'cached'), null);
  if (!hasCritical(scan)) return null;
  const n = scan!.findings.filter((f) => f.severity === 'critical').length;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm"
    >
      <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
      <span className="font-medium">
        The security check found {n} {n === 1 ? 'problem' : 'problems'} that
        need action now.
      </span>
      <Link
        href="/settings/security-checks"
        className="underline underline-offset-2 hover:no-underline"
      >
        See what it found
      </Link>
    </div>
  );
}
