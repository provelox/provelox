import { NextResponse } from 'next/server';
import { callApi } from '@/lib/api-long';
import { APP_NAME_RE } from '@/lib/app-name';
import { env } from '@/lib/env';
import { destroySession, getSession } from '@/lib/session';
import { VOLUME_NAME_RE } from '@/lib/volume-download';
import { isVolumeFileName } from '@/lib/volume-import';

export const dynamic = 'force-dynamic';

/** Always JSON: the browser sends this with a script (for its progress bar), never by opening the address. */
const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status });

/**
 * Restores into one of the app's volumes, and returns the API's answer. Two ways, chosen by the address:
 *
 * - With a body (an archive from the browser), it is handed on to the API as it arrives, never held: the archive of a
 *   database can be many gigabytes. If the browser goes away half way, the request to the API is cut too, and the API
 *   starts the app again.
 * - With `?from=<file name>` and no body, the archive is a file already in the import folder on the server. Only the name
 *   is passed on: the API finds the file itself, and the work goes on even if the browser goes away.
 *
 * The API token stays here. The calls use plain `http` (see callApi), because the answer only comes once the files are
 * written, which can take a long time.
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

  const q = new URL(req.url).searchParams;
  const replace = q.get('replace') === '1';
  const confirm = q.get('confirm') ?? '';
  const from = q.get('from');
  if (replace && !APP_NAME_RE.test(confirm))
    return fail(400, 'Type the name of the app to replace what is in it.');
  if (from !== null) {
    if (!isVolumeFileName(from))
      return fail(
        400,
        'That is not a file name the import folder can hold (.tar.gz or .tgz, letters, digits and . _ - only).',
      );
  } else if (!req.body) return fail(400, 'There is no file in the request.');

  const query = new URLSearchParams();
  if (from !== null) query.set('from', from);
  if (replace) {
    query.set('replace', '1');
    query.set('confirm', confirm);
  }
  const qs = query.toString() ? `?${query.toString()}` : '';
  let upstream: { status: number; body: unknown };
  try {
    upstream = await callApi(
      'POST',
      new URL(
        `${env().PROVELOX_API_URL}/v1/apps/${name}/volumes/${encodeURIComponent(volume)}/restore${qs}`,
      ),
      session.token,
      from !== null
        ? // not tied to the browser: hanging up does not cancel a restore the API is making from a file it already has
          { signal: new AbortController().signal }
        : {
            body: req.body,
            contentType: 'application/gzip',
            signal: req.signal,
          },
    );
  } catch (error) {
    if (req.signal.aborted) return fail(499, 'The request was cancelled.');
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
    return fail(401, 'Your session has ended. Sign in again, then restore.');
  }
  if (upstream.status === 403)
    return fail(
      403,
      'Restoring data needs the administrator sign-in, not an access token.',
    );
  if (upstream.status < 200 || upstream.status >= 300)
    return fail(
      upstream.status,
      body?.error?.message ?? 'The API could not restore the data.',
    );
  return NextResponse.json(body ?? { restored: true });
}
