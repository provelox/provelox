'use server';

import { loadSecurity } from '@/lib/backend';
import type { SecurityScan } from '@/lib/security';
import { asUser, type ActionResult } from './guard';

/** Runs the check now (it looks at the machine, so it takes a few seconds) and returns what it found. */
export async function checkSecurityAction(): Promise<
  ActionResult<SecurityScan>
> {
  return asUser((token) => loadSecurity(token, 'fresh'));
}
