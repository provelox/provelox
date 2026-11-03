import { elapsed, withHeartbeat } from './progress';

describe('elapsed', () => {
  it('reads as minutes and seconds', () => {
    expect(elapsed(12_000)).toBe('12s');
    expect(elapsed(65_000)).toBe('1m 05s');
    expect(elapsed(3_605_000)).toBe('60m 05s');
  });
});

describe('withHeartbeat', () => {
  afterEach(() => jest.useRealTimers());

  it('says it is still going while the work runs, and stops when it ends', async () => {
    jest.useFakeTimers();
    const lines: string[] = [];
    let t = 0;
    let finish!: (v: string) => void;
    const work = new Promise<string>((r) => (finish = r));
    const p = withHeartbeat(work, (l) => lines.push(l), 'db: still copying', {
      everyMs: 10_000,
      now: () => t,
    });
    t = 10_000;
    jest.advanceTimersByTime(10_000);
    t = 20_000;
    jest.advanceTimersByTime(10_000);
    finish('done');
    await expect(p).resolves.toBe('done');
    expect(lines).toEqual([
      'db: still copying (10s)',
      'db: still copying (20s)',
    ]);
    jest.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(2);
  });

  it('stops saying it when the work fails, and passes the failure on', async () => {
    jest.useFakeTimers();
    const lines: string[] = [];
    const p = withHeartbeat(
      Promise.reject(new Error('boom')),
      (l) => lines.push(l),
      'x',
    );
    await expect(p).rejects.toThrow('boom');
    jest.advanceTimersByTime(60_000);
    expect(lines).toEqual([]);
  });
});
