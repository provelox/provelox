import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/session';

/**
 * Where pages send you when Provelox rejects the login token (for example after Provelox restarted or the
 * password changed). Server components cannot clear cookies, this route can. Without it the stale cookie would
 * make /login bounce straight back to /apps, which would bounce back to /login, forever.
 */
export async function GET(req: Request) {
  await destroySession();
  return NextResponse.redirect(new URL('/login', req.url));
}
