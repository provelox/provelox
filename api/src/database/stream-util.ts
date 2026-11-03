import { Readable, Transform, type TransformCallback } from 'node:stream';

/**
 * Resolves with whether any bytes came, once the first bytes are readable or the stream ended: so a tool that fails at
 * once is an error with its message, and not an empty download that looks like it worked.
 */
export function startedWithBytes(s: Readable): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      s.off('readable', onReadable);
      s.off('end', onEnd);
      s.off('close', onEnd);
    };
    const onEnd = () => {
      cleanup();
      resolve(s.readableLength > 0);
    };
    const onReadable = () => {
      if (s.readableLength > 0) {
        cleanup();
        resolve(true);
      } else s.read();
    };
    s.on('readable', onReadable);
    s.once('end', onEnd);
    s.once('close', onEnd);
  });
}

/**
 * The first `want` bytes of a stream (less if it is shorter), and a stream with everything in it again, those bytes
 * first. Only the head is held; the rest passes through as it arrives.
 */
export async function takeHead(
  src: Readable,
  want = 8192,
): Promise<{ head: Buffer; whole: Readable }> {
  const it = src[Symbol.asyncIterator]();
  const parts: Buffer[] = [];
  let total = 0;
  let ended = false;
  while (total < want) {
    const n = await it.next();
    if (n.done) {
      ended = true;
      break;
    }
    const b = Buffer.from(n.value as Buffer);
    parts.push(b);
    total += b.length;
  }
  const head = Buffer.concat(parts);
  const whole = Readable.from(
    (async function* () {
      try {
        if (head.length) yield head;
        while (!ended) {
          const n = await it.next();
          if (n.done) return;
          yield n.value as Buffer;
        }
      } finally {
        await it.return?.(undefined);
      }
    })(),
    { objectMode: false },
  );
  return { head, whole };
}

/** Counts the bytes that pass through, and changes none of them */
export class ByteCounter extends Transform {
  count = 0;
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.count += chunk.length;
    cb(null, chunk);
  }
}

/**
 * The end of a tool's error output, for an error message: the last few lines, each cut short. The tools are given their
 * credentials in the container's environment and never on a command line, so they do not repeat them; this is still
 * only ever the end of the text, not all of it.
 */
export function tail(stderr: string, lines = 8): string {
  return stderr
    .split('\n')
    .map((l) => l.trim().slice(0, 300))
    .filter(Boolean)
    .slice(-lines)
    .join(' ');
}
