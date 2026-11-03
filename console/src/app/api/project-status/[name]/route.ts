import { NextResponse } from 'next/server';
import { BackendError, loadProject } from '@/lib/backend';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Read-only: lets the browser watch a project's services come up. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!/^[a-z0-9]([a-z0-9-]{0,47}[a-z0-9])?$/.test(name))
    return NextResponse.json(
      { error: 'Invalid project name' },
      { status: 400 },
    );

  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    const p = await loadProject(session.token, name);
    return NextResponse.json({ services: p.services });
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
