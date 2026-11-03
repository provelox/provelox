import { NextResponse } from 'next/server';
import { loginUrl } from '@/lib/after-login';
import { APP_NAME_RE } from '@/lib/app-name';
import { env } from '@/lib/env';
import { destroySession, getSession } from '@/lib/session';
import { VOLUME_NAME_RE } from '@/lib/volume-download';

export const dynamic = 'force-dynamic';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/**
 * What a browser that opened the download in a tab sees when it cannot start: a plain page that says why. (A program that
 * asks for JSON gets JSON.)
 */
function refusal(req: Request, status: number, message: string) {
  if (req.headers.get('accept')?.includes('text/html'))
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download failed</title><body style="font:16px system-ui;max-width:36rem;margin:12vh auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">The download could not start</h1><p>${esc(message)}</p><p><a href="javascript:window.close()">Close this tab</a></p>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  return NextResponse.json({ error: message }, { status });
}

/**
 * Hands a volume's contents to the browser as a file. The browser opens this address (a plain link, so it is a real
 * download with its own progress bar, never read into the page); the API token stays here, and the archive passes
 * through as it comes, never held.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string; volume: string }> },
) {
  const { name, volume } = await ctx.params;
  if (!APP_NAME_RE.test(name)) return refusal(req, 400, 'Invalid app name');
  if (!VOLUME_NAME_RE.test(volume))
    return refusal(req, 400, 'Invalid volume name');

  // Someone who opened this address in a browser without being signed in is sent to sign in, then to the app's own page
  // to ask again: never straight back to this address, which can stop the app when it is opened.
  const toLogin = () =>
    new Response(null, {
      status: 303,
      headers: {
        Location: loginUrl(`/apps/${name}/configuration`),
        'Cache-Control': 'no-store',
      },
    });
  const wantsPage = req.headers.get('accept')?.includes('text/html');

  const session = await getSession();
  if (!session)
    return wantsPage ? toLogin() : refusal(req, 401, 'Not signed in');

  const stop = new URL(req.url).searchParams.get('stop') === '1';
  let upstream: Response;
  try {
    upstream = await fetch(
      `${env().PROVELOX_API_URL}/v1/apps/${name}/volumes/${encodeURIComponent(volume)}/download${stop ? '?stop=1' : ''}`,
      {
        cache: 'no-store',
        headers: { authorization: `Bearer ${session.token}` },
        // The tab or download being cancelled stops the copy on the API side too
        signal: req.signal,
      },
    );
  } catch (error) {
    console.error(
      'Failed to reach the Provelox API',
      error instanceof Error ? error.message : error,
    );
    return refusal(req, 502, 'Cannot reach the Provelox API');
  }

  if (
    !upstream.ok ||
    !upstream.body ||
    !upstream.headers.get('content-type')?.includes('application/gzip')
  ) {
    if (upstream.status === 401) {
      await destroySession();
      return wantsPage ? toLogin() : refusal(req, 401, 'Session expired');
    }
    const body = (await upstream.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return refusal(
      req,
      upstream.status === 403 ? 403 : upstream.ok ? 502 : upstream.status,
      upstream.status === 403
        ? 'Downloading data needs the administrator sign-in, not an access token.'
        : (body?.error?.message ?? 'The API could not start the download.'),
    );
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition':
        upstream.headers.get('content-disposition') ??
        `attachment; filename="${name}-${volume}.tar.gz"`,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
