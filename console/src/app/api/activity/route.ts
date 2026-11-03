import { NextResponse } from 'next/server';
import { filtersFrom } from '@/lib/activity';
import { BackendError, loadActivity } from '@/lib/backend';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Read-only: the next, older page of the activity log, for "Load older" in the browser. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const before = Number(params.get('before'));
  try {
    return NextResponse.json(
      await loadActivity(
        session.token,
        filtersFrom(Object.fromEntries(params)),
        { before: Number.isInteger(before) && before > 0 ? before : null },
      ),
    );
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
