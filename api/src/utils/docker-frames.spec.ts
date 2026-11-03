import { FrameDemux } from './docker-frames';

const frame = (kind: 1 | 2, text: string | Buffer) => {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = kind;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
};

async function run(chunks: Buffer[]) {
  const d = new FrameDemux();
  const out: Buffer[] = [];
  d.on('data', (c: Buffer) => out.push(c));
  for (const c of chunks) d.write(c);
  d.end();
  await new Promise((r) => d.once('end', r));
  return { out: Buffer.concat(out), stderr: d.stderr };
}

describe('FrameDemux', () => {
  it('passes what the program wrote and keeps what it complained about', async () => {
    const r = await run([
      frame(1, 'hello '),
      frame(2, 'tar: warning'),
      frame(1, 'world'),
    ]);
    expect(r.out.toString()).toBe('hello world');
    expect(r.stderr).toBe('tar: warning');
  });

  it('is not confused by the stream being cut anywhere, even inside a header', async () => {
    const whole = Buffer.concat([
      frame(1, Buffer.from([0, 1, 2, 3, 250, 251])),
      frame(2, 'oops'),
      frame(1, 'tail'),
    ]);
    // one byte at a time is the worst case
    const r = await run([...whole].map((b) => Buffer.from([b])));
    expect(r.out).toEqual(
      Buffer.concat([Buffer.from([0, 1, 2, 3, 250, 251]), Buffer.from('tail')]),
    );
    expect(r.stderr).toBe('oops');
  });

  it('keeps only the end of a long error output', async () => {
    const r = await run([frame(2, 'x'.repeat(20_000)), frame(2, 'END')]);
    expect(r.stderr.length).toBeLessThanOrEqual(8 * 1024);
    expect(r.stderr.endsWith('END')).toBe(true);
  });
});
