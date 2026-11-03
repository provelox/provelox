export interface LogLine {
  /** RFC 3339 timestamp Docker added, or '' when the line had none */
  ts: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

const HEADER = 8;
const TS = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?/;

/**
 * Turns Docker's log stream into lines. Containers without a TTY send 8-byte-framed chunks (stream type + length),
 * and frames and lines can both be cut anywhere between network chunks, so this keeps what is incomplete.
 * Streams from a TTY are plain text; that is detected from the first byte.
 */
export class LogDemux {
  private buf = Buffer.alloc(0);
  private partial: Record<'stdout' | 'stderr', string> = {
    stdout: '',
    stderr: '',
  };
  private framed: boolean | null = null;

  push(chunk: Buffer): LogLine[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: LogLine[] = [];
    if (this.framed === null && this.buf.length > 0)
      this.framed = this.buf[0] <= 2;

    if (!this.framed) {
      this.text('stdout', this.buf.toString('utf8'), out);
      this.buf = Buffer.alloc(0);
      return out;
    }
    while (this.buf.length >= HEADER) {
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < HEADER + size) break;
      const kind = this.buf[0] === 2 ? 'stderr' : 'stdout';
      this.text(
        kind,
        this.buf.subarray(HEADER, HEADER + size).toString('utf8'),
        out,
      );
      this.buf = this.buf.subarray(HEADER + size);
    }
    return out;
  }

  /** Whatever is left when the stream ends (a last line without a newline). */
  end(): LogLine[] {
    const out: LogLine[] = [];
    for (const s of ['stdout', 'stderr'] as const)
      if (this.partial[s]) {
        out.push(this.parse(s, this.partial[s]));
        this.partial[s] = '';
      }
    return out;
  }

  private text(stream: 'stdout' | 'stderr', data: string, out: LogLine[]) {
    const lines = (this.partial[stream] + data).split('\n');
    this.partial[stream] = lines.pop() ?? '';
    for (const l of lines) out.push(this.parse(stream, l.replace(/\r$/, '')));
  }

  private parse(stream: 'stdout' | 'stderr', line: string): LogLine {
    const m = TS.exec(line);
    return m
      ? { ts: m[1], stream, text: line.slice(m[0].length) }
      : { ts: '', stream, text: line };
  }
}
