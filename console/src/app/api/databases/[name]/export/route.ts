import { NextResponse } from 'next/server';
import { callApi } from '@/lib/api-long';
import { APP_NAME_RE } from '@/lib/app-name';
import { env } from '@/lib/env';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Always JSON: the page calls this with a script, never by opening the address. */
const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status });

/**
 * Asks the API to save a dump of the app's database into the import folder on the server, and returns what it saved
 * (`{file, sizeBytes, dir}`). The answer only comes once the dump is complete, which can take a long time for a large
 * database, so the call has no time limit of its own (see callApi), and the dump goes on even if the browser goes away.
 * A POST with no body: it writes a file, so it is never a plain link. `?all=1` dumps every database of the server.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!APP_NAME_RE.test(name)) return fail(400, 'Invalid app name');

  const session = await getSession();
  if (!session) return fail(401, 'Not signed in');

  const all = new URL(req.url).searchParams.get('all') === '1';
  let upstream: { status: number; body: unknown };
  try {
    upstream = await callApi(
      'POST',
      new URL(
        `${env().PROVELOX_API_URL}/v1/apps/${name}/database/export${all ? '?all=1' : ''}`,
      ),
      session.token,
      // not tied to the browser: hanging up does not cancel a dump the API is making
      { signal: new AbortController().signal },
    );
  } catch (error) {
    console.error(
      'Failed to reach the Provelox API',
      error instanceof Error ? error.message : error,
    );
    return fail(502, 'Cannot reach the Provelox API');
  }

  const body = upstream.body as { error?: { message?: string } } | null;
  if (upstream.status === 401) {
    await destroySession();
    return fail(401, 'Your session has ended. Sign in again, then try again.');
  }
  if (upstream.status === 403)
    return fail(
      403,
      'Saving a backup needs the administrator sign-in, not an access token.',
    );
  if (upstream.status < 200 || upstream.status >= 300)
    return fail(
      upstream.status,
      body?.error?.message ?? 'The API could not save the backup.',
    );
  return NextResponse.json(body);
}
