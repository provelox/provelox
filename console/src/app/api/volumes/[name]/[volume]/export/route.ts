import { NextResponse } from 'next/server';
import { callApi } from '@/lib/api-long';
import { APP_NAME_RE } from '@/lib/app-name';
import { env } from '@/lib/env';
import { destroySession, getSession } from '@/lib/session';
import { VOLUME_NAME_RE } from '@/lib/volume-download';

export const dynamic = 'force-dynamic';

/** Always JSON: the browser calls this with a script, never by opening the address. */
const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status });

/**
 * Asks the API to save a copy of one of the app's volumes into the import folder on the server, and returns what it
 * saved (`{file, sizeBytes, dir, stopped, note}`). The answer only comes once the copy is complete, which can take a
 * long time for a large volume, so the call has no time limit of its own (see callApi). The copy goes on, and the app
 * is started again, even if the browser goes away. A POST with no body: it changes things, so it is never a plain link.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string; volume: string }> },
) {
  const { name, volume } = await ctx.params;
  if (!APP_NAME_RE.test(name)) return fail(400, 'Invalid app name');
  if (!VOLUME_NAME_RE.test(volume)) return fail(400, 'Invalid volume name');

  const session = await getSession();
  if (!session) return fail(401, 'Not signed in');

  const stop = new URL(req.url).searchParams.get('stop') === '1';
  let upstream: { status: number; body: unknown };
  try {
    upstream = await callApi(
      'POST',
      new URL(
        `${env().PROVELOX_API_URL}/v1/apps/${name}/volumes/${encodeURIComponent(volume)}/export${stop ? '?stop=1' : ''}`,
      ),
      session.token,
      // not tied to the browser: hanging up does not cancel a copy the API is making
      { signal: new AbortController().signal },
    );
  } catch (error) {
    console.error(
      'Failed to reach the Provelox API',
      error instanceof Error ? error.message : error,
    );
    return fail(502, 'Cannot reach the Provelox API');
  }

  const body = upstream.body as {
    error?: { message?: string };
  } | null;
  if (upstream.status === 401) {
    await destroySession();
    return fail(401, 'Your session has ended. Sign in again, then try again.');
  }
  if (upstream.status === 403)
    return fail(
      403,
      'Saving a copy needs the administrator sign-in, not an access token.',
    );
  if (upstream.status < 200 || upstream.status >= 300)
    return fail(
      upstream.status,
      body?.error?.message ?? 'The API could not save the copy.',
    );
  return NextResponse.json(body);
}
