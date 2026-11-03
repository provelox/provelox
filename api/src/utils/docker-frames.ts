import { Transform, type TransformCallback } from 'node:stream';

const HEADER = 8;
/** What is kept of the helper's error output: enough to say why it failed, never a whole stream of it */
const STDERR_KEEP = 8 * 1024;

/**
 * Splits the stream Docker gives for a container without a terminal into what the program wrote: its output comes out of
 * this stream, its error output is kept (the last few kilobytes) in `stderr`. Docker frames each piece with an 8-byte
 * header (which stream, and how long). A Transform, so a slow reader slows Docker down instead of filling memory: the
 * archive of a large volume is never held, only the piece in flight.
 */
export class FrameDemux extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private kind = 0;
  /** Bytes of the current frame still to come; 0 when the next bytes are a header */
  private left = 0;
  private err: Buffer = Buffer.alloc(0);

  /** What the program said on its error output (the end of it) */
  get stderr(): string {
    return this.err.toString('utf8').trim();
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length > 0) {
      if (this.left === 0) {
        if (this.buf.length < HEADER) break;
        this.kind = this.buf[0];
        this.left = this.buf.readUInt32BE(4);
        this.buf = this.buf.subarray(HEADER);
        continue;
      }
      const take = Math.min(this.left, this.buf.length);
      const piece = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      this.left -= take;
      if (this.kind === 1) this.push(Buffer.from(piece));
      else if (this.kind === 2)
        this.err = Buffer.concat([this.err, piece]).subarray(-STDERR_KEEP);
    }
    cb();
  }
}
