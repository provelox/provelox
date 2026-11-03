import { NextResponse } from 'next/server';
import { loginUrl } from '@/lib/after-login';
import { APP_NAME_RE } from '@/lib/app-name';
import { env } from '@/lib/env';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/** What a browser that opened the dump in a tab sees when it cannot start. (A program that asks for JSON gets JSON.) */
function refusal(req: Request, status: number, message: string) {
  if (req.headers.get('accept')?.includes('text/html'))
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backup failed</title><body style="font:16px system-ui;max-width:36rem;margin:12vh auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">The backup could not start</h1><p>${esc(message)}</p><p><a href="javascript:window.close()">Close this tab</a></p>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  return NextResponse.json({ error: message }, { status });
}

/**
 * Hands a dump of the app's database to the browser as a file. The browser opens this address (a plain link, so it is a
 * real download with its own progress bar, never read into the page); the API token stays here, and the dump passes
 * through as it comes, never held.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!APP_NAME_RE.test(name)) return refusal(req, 400, 'Invalid app name');

  // Someone who opened this address in a browser without being signed in is sent to sign in, then to the app's own page
  // to ask again: never straight back to this address.
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

  const all = new URL(req.url).searchParams.get('all') === '1';
  let upstream: Response;
  try {
    upstream = await fetch(
      `${env().PROVELOX_API_URL}/v1/apps/${name}/database/dump${all ? '?all=1' : ''}`,
      {
        cache: 'no-store',
        headers: { authorization: `Bearer ${session.token}` },
        // The tab or download being cancelled stops the dump inside the container too
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

  const type = upstream.headers.get('content-type') ?? '';
  if (
    !upstream.ok ||
    !upstream.body ||
    !(type.includes('application/gzip') || type.includes('octet-stream'))
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
        ? 'Backing up a database needs the administrator sign-in, not an access token.'
        : (body?.error?.message ?? 'The API could not start the backup.'),
    );
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition':
        upstream.headers.get('content-disposition') ??
        `attachment; filename="${name}.dump"`,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
