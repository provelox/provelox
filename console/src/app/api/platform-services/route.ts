import { NextResponse } from 'next/server';
import { BackendError, loadPlatformServices } from '@/lib/backend';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Read-only: lets the browser poll the state and usage of the platform's own services. Every change goes through Server Actions instead. */
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    return NextResponse.json(await loadPlatformServices(session.token));
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
