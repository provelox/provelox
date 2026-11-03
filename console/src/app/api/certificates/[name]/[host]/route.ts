import { NextResponse } from 'next/server';
import { APP_NAME_RE } from '@/lib/app-name';
import { api, BackendError } from '@/lib/backend';
import type { CertificateDiagnosis } from '@/lib/certificates';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const HOSTNAME =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Read-only: why one address has no certificate, for the panel that polls while it waits. Retrying goes through a Server Action. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string; host: string }> },
) {
  const { name, host } = await ctx.params;
  if (!APP_NAME_RE.test(name) || !HOSTNAME.test(host.toLowerCase()))
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });

  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    return NextResponse.json(
      await api<CertificateDiagnosis>(
        `apps/${encodeURIComponent(name)}/domains/${encodeURIComponent(host.toLowerCase())}/diagnosis`,
        { token: session.token },
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
