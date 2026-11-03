import { NextResponse } from 'next/server';
import { callApi } from '@/lib/api-long';
import { APP_NAME_RE } from '@/lib/app-name';
import { isDumpFileName } from '@/lib/database-backup';
import { env } from '@/lib/env';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Always JSON: the page calls this with a script, never by opening the address. */
const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status });

/**
 * Restores a dump into the app's database, which is the database's own restore tool at the API. Two ways in:
 *
 * - With a body (a dump from the browser), it is handed on to the API as it arrives, never held: the dump of a database
 *   can be many gigabytes. If the browser goes away half way, the request to the API is cut too and the tool is stopped.
 * - With `?from=<file name>` and no body, the dump is a file already in the import folder on the server (put there with
 *   rsync or scp, or saved by "Save a backup on the server"). Only the name is sent on; nothing is uploaded, so the file
 *   can be as large as the disk, and the restore goes on if the browser goes away.
 *
 * The API token stays here. The calls use plain `http` (see callApi), because the answer only comes once the data is
 * restored, which can take a long time. Errors are JSON, and a signed-out caller is told so rather than sent anywhere.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!APP_NAME_RE.test(name)) return fail(400, 'Invalid app name');

  const session = await getSession();
  if (!session) return fail(401, 'Not signed in');

  const q = new URL(req.url).searchParams;
  const clean = q.get('clean') === '1';
  const confirm = q.get('confirm') ?? '';
  const from = q.get('from');
  if (clean && !APP_NAME_RE.test(confirm))
    return fail(400, 'Type the name of the app to replace what is in it.');
  if (from !== null) {
    if (!isDumpFileName(from))
      return fail(
        400,
        'That is not a file name a database restore can use (.dump, .sql or .sql.gz; letters, digits and . _ - only).',
      );
  } else if (!req.body) return fail(400, 'No file was sent.');

  const query = new URLSearchParams();
  if (from !== null) query.set('from', from);
  if (clean) {
    query.set('clean', '1');
    query.set('confirm', confirm);
  }
  const qs = query.toString() ? `?${query.toString()}` : '';

  let upstream: { status: number; body: unknown };
  try {
    upstream = await callApi(
      'POST',
      new URL(
        `${env().PROVELOX_API_URL}/v1/apps/${name}/database/restore${qs}`,
      ),
      session.token,
      from !== null
        ? // not tied to the browser: hanging up does not cancel a restore the API is making from a file it already has
          { signal: new AbortController().signal }
        : {
            body: req.body,
            contentType: 'application/octet-stream',
            // The upload being cancelled stops the restore in the container too
            signal: req.signal,
          },
    );
  } catch (error) {
    if (req.signal.aborted) return fail(499, 'The upload was cancelled.');
    console.error(
      'Failed to reach the Provelox API',
      error instanceof Error ? error.message : error,
    );
    return fail(502, 'Cannot reach the Provelox API');
  }

  const body = upstream.body as { error?: { message?: string } } | null;
  if (upstream.status === 401) {
    await destroySession();
    return fail(401, 'Your session has ended. Sign in again, then restore.');
  }
  if (upstream.status === 403)
    return fail(
      403,
      'Restoring a database needs the administrator sign-in, not an access token.',
    );
  if (upstream.status < 200 || upstream.status >= 300)
    return fail(
      upstream.status,
      body?.error?.message ?? 'The API could not restore the dump.',
    );
  return NextResponse.json(body ?? { restored: true });
}
