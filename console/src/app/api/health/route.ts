import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Whether the API answers, for the waiting screen to poll. Needs no sign-in and says nothing but yes or no, so it is
 * safe to ask while everything else is down. It gives up after three seconds.
 */
export async function GET() {
  let api: 'ok' | 'down' = 'down';
  try {
    const res = await fetch(`${env().PROVELOX_API_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) api = 'ok';
  } catch {
    // unreachable or too slow: down
  }
  return NextResponse.json(
    { api },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
