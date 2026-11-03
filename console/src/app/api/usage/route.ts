import { gzipSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import { BackendError, loadUsageAll } from '@/lib/backend';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Read-only: lets the browser poll what every running app uses right now, for the apps list. Every change goes through Server Actions instead.
 *
 * Sent compressed when the browser accepts it: Next compresses its pages but not what a route handler returns, and this
 * answer is one entry for every running app, repeated every ten seconds (about 76 KB for a thousand apps, 7 KB packed).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    const body = JSON.stringify(await loadUsageAll(session.token));
    const pack =
      body.length > 1024 &&
      /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '');
    return new Response(pack ? gzipSync(body) : body, {
      headers: {
        'content-type': 'application/json',
        vary: 'accept-encoding',
        ...(pack ? { 'content-encoding': 'gzip' } : {}),
      },
    });
  } catch (e) {
    if (e instanceof BackendError) {
      if (e.isAuthFailure) {
        await destroySession();
        return NextResponse.json({ error: 'Session expired' }, { status: 401 });
      }
      return NextResponse.json(
        { error: e.message },
        { status: e.status === 0 ? 502 : e.status === 404 ? 404 : 400 },
      );
    }
    throw e;
  }
}
