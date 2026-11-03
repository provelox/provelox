import { describe, expect, it } from 'vitest';
import { reframe } from '@/lib/sse-reframe';

async function run(chunks: string[]) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  }).pipeThrough(reframe());
  const out: string[] = [];
  const dec = new TextDecoder();
  for await (const v of stream as unknown as AsyncIterable<Uint8Array>)
    out.push(dec.decode(v));
  return out.join('');
}

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe('reframe', () => {
  it('turns API events into the console shape', async () => {
    const out = await run([ev({ ts: 't', stream: 'stderr', text: 'boom' })]);
    expect(out).toBe(ev({ line: 'boom', stream: 'stderr' }));
  });
  it('handles events split anywhere between chunks', async () => {
    const whole =
      ev({ ts: '', stream: 'stdout', text: 'héllo ✓' }) +
      ev({ ts: '', stream: 'stdout', text: 'two' });
    const bytes = new TextEncoder().encode(whole);
    // one byte at a time, including inside a multibyte character
    const chunks = Array.from(bytes, (b) => String.fromCharCode(b));
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    }).pipeThrough(reframe());
    const dec = new TextDecoder();
    let out = '';
    for await (const v of stream as unknown as AsyncIterable<Uint8Array>)
      out += dec.decode(v);
    expect(out).toBe(
      ev({ line: 'héllo ✓', stream: 'stdout' }) +
        ev({ line: 'two', stream: 'stdout' }),
    );
    void chunks;
    void enc;
  });
  it('passes pings and the end event through unchanged', async () => {
    expect(await run([': ping\n\n'])).toBe(': ping\n\n');
    expect(await run(['event: end\ndata: {}\n\n'])).toBe(
      'event: end\ndata: {}\n\n',
    );
  });
  it('drops a malformed event instead of breaking the stream', async () => {
    const out = await run([
      'data: {not json\n\n',
      ev({ ts: '', stream: 'stdout', text: 'ok' }),
    ]);
    expect(out).toBe(ev({ line: 'ok', stream: 'stdout' }));
  });
  it('does not emit an event that has not finished yet', async () => {
    expect(await run(['data: {"ts":"","stream":"stdout","text":"par'])).toBe(
      '',
    );
  });
});
