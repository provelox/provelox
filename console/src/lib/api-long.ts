import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/**
 * A call to the Provelox API that may take a long time to answer (a restore, a copy of a volume: minutes, or more), made
 * with plain `http` and no timeout of its own. `fetch` gives up on an answer that takes more than five minutes to
 * start, which would cut a long job off while the API is still doing it. A body, if there is one, is passed on as it
 * arrives (chunked), so nothing is held and no length has to be known. Cutting `signal` cuts the request.
 */
export function callApi(
  method: 'POST' | 'GET' | 'DELETE',
  url: URL,
  token: string,
  opts: {
    body?: ReadableStream<Uint8Array> | null;
    contentType?: string;
    signal: AbortSignal;
  },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const up = lib.request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body && opts.contentType
            ? { 'content-type': opts.contentType }
            : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
          } catch {
            // an answer that is not JSON: the caller says what it can
          }
          resolve({ status: res.statusCode ?? 502, body: parsed });
        });
        res.on('error', reject);
      },
    );
    up.on('error', reject);
    const cut = () => up.destroy(new Error('The request was cancelled.'));
    if (opts.signal.aborted) cut();
    else opts.signal.addEventListener('abort', cut, { once: true });
    if (!opts.body) {
      up.end();
      return;
    }
    const src = Readable.fromWeb(opts.body as never);
    // The browser's side failing half way ends the request to the API too, so it can start the app again
    src.on('error', cut);
    src.pipe(up);
  });
}
