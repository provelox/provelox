import { LogDemux } from './docker-log';

const frame = (kind: 1 | 2, text: string) => {
  const body = Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = kind;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
};

describe('LogDemux', () => {
  it('splits framed output into lines with stream and timestamp', () => {
    const d = new LogDemux();
    const out = d.push(
      Buffer.concat([
        frame(1, '2026-01-01T10:00:00.123Z hello\n'),
        frame(2, '2026-01-01T10:00:01Z oops\n'),
      ]),
    );
    expect(out).toEqual([
      { ts: '2026-01-01T10:00:00.123Z', stream: 'stdout', text: 'hello' },
      { ts: '2026-01-01T10:00:01Z', stream: 'stderr', text: 'oops' },
    ]);
  });

  it('handles frames cut anywhere between chunks', () => {
    const d = new LogDemux();
    const all = Buffer.concat([frame(1, 'a\nb\n'), frame(1, 'c\n')]);
    const lines = [];
    for (let i = 0; i < all.length; i++)
      lines.push(...d.push(all.subarray(i, i + 1)));
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('joins a line that is spread over several frames', () => {
    const d = new LogDemux();
    expect(d.push(frame(1, 'par'))).toEqual([]);
    expect(d.push(frame(1, 'tial\n')).map((l) => l.text)).toEqual(['partial']);
  });

  it('keeps stdout and stderr partial lines apart', () => {
    const d = new LogDemux();
    d.push(frame(1, 'out-'));
    d.push(frame(2, 'err-'));
    const lines = d.push(
      Buffer.concat([frame(1, 'done\n'), frame(2, 'done\n')]),
    );
    expect(lines.map((l) => `${l.stream}:${l.text}`)).toEqual([
      'stdout:out-done',
      'stderr:err-done',
    ]);
  });

  it('flushes a last line without a newline on end()', () => {
    const d = new LogDemux();
    d.push(frame(1, 'no newline'));
    expect(d.end()).toEqual([{ ts: '', stream: 'stdout', text: 'no newline' }]);
    expect(d.end()).toEqual([]);
  });

  it('accepts plain (TTY) output', () => {
    const d = new LogDemux();
    expect(
      d
        .push(Buffer.from('2026-01-01T00:00:00Z one\r\ntwo\n'))
        .map((l) => l.text),
    ).toEqual(['one', 'two']);
  });

  it('handles lines without timestamps and multibyte text', () => {
    const d = new LogDemux();
    expect(d.push(frame(1, 'héllo ✓\n'))).toEqual([
      { ts: '', stream: 'stdout', text: 'héllo ✓' },
    ]);
  });

  it('does not wait forever on an oversized length: it just keeps buffering until complete', () => {
    const d = new LogDemux();
    const h = Buffer.alloc(8);
    h[0] = 1;
    h.writeUInt32BE(10, 4);
    expect(d.push(Buffer.concat([h, Buffer.from('abc')]))).toEqual([]);
    expect(d.push(Buffer.from('defghi\n')).map((l) => l.text)).toEqual([
      'abcdefghi',
    ]);
  });
});
