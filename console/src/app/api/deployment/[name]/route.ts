import { NextResponse } from 'next/server';
import { APP_NAME_RE } from '@/lib/app-name';
import { BackendError, loadDeployment } from '@/lib/backend';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Read-only: lets the browser poll how a deploy is going. Every change goes through Server Actions instead. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!APP_NAME_RE.test(name))
    return NextResponse.json({ error: 'Invalid app name' }, { status: 400 });

  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    return NextResponse.json(await loadDeployment(session.token, name));
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
