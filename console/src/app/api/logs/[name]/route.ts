import { NextResponse } from 'next/server';
import { APP_NAME_RE } from '@/lib/app-name';
import { env } from '@/lib/env';
import { reframe } from '@/lib/sse-reframe';
import { destroySession, getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Live runtime logs. Relays the API's Server-Sent Events stream to the browser, so the API token stays
 * server-side and the browser can use a plain EventSource with the session cookie.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!APP_NAME_RE.test(name))
    return NextResponse.json({ error: 'Invalid app name' }, { status: 400 });

  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(
      `${env().PROVELOX_API_URL}/v1/apps/${name}/logs?follow=1&tail=200`,
      {
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${session.token}`,
          accept: 'text/event-stream',
        },
        // Closing the browser tab aborts the request, which closes the stream on the API side too
        signal: req.signal,
      },
    );
  } catch (error) {
    console.error(
      'Failed to reach the Provelox API',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: 'Cannot reach the Provelox API' },
      { status: 502 },
    );
  }

  // Errors (unknown app, expired token...) come back as normal JSON instead of a stream
  if (
    !upstream.headers.get('content-type')?.includes('text/event-stream') ||
    !upstream.body
  ) {
    if (upstream.status === 401) {
      await destroySession();
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }
    const body = (await upstream.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return NextResponse.json(
      { error: body?.error?.message ?? 'Could not open the log stream' },
      { status: upstream.status === 404 ? 404 : 400 },
    );
  }

  return new Response(upstream.body.pipeThrough(reframe()), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
