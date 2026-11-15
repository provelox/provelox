import {
  cpuTimes,
  memAvailable,
  pressureSome60,
  readHostStats,
  type HostProbe,
} from './host-stats';

const probe = (over: Partial<HostProbe> = {}): HostProbe => ({
  cpus: () => 4,
  loadavg: () => [0.5, 1, 1.5],
  totalmem: () => 8_000_000_000,
  freemem: () => 500_000_000,
  uptime: () => 90061.7,
  meminfo: () => 'MemTotal: 7812500 kB\nMemAvailable:    3906250 kB\n',
  statfs: () => ({ blocks: 1000, bfree: 300, bavail: 250, bsize: 4096 }),
  ...over,
});

describe('readHostStats', () => {
  it('counts caches as available memory, not as used', () => {
    const s = readHostStats('/data', probe());
    expect(s.memoryTotalBytes).toBe(8_000_000_000);
    expect(s.memoryUsedBytes).toBe(8_000_000_000 - 3_906_250 * 1024);
  });
  it('falls back to os.freemem without /proc/meminfo (macOS in development)', () => {
    const s = readHostStats('/data', probe({ meminfo: () => null }));
    expect(s.memoryUsedBytes).toBe(7_500_000_000);
  });
  it('reports disk, load, cpus and whole seconds of uptime', () => {
    const s = readHostStats('/data', probe());
    expect(s).toMatchObject({
      cpus: 4,
      load: [0.5, 1, 1.5],
      diskPath: '/data',
      // 700 used + 250 available: the 50 reserved blocks are not part of the total
      diskTotalBytes: 950 * 4096,
      diskFreeBytes: 250 * 4096,
      uptimeSeconds: 90061,
    });
  });
  it('agrees with df on how full the disk is (the reserved blocks are not counted as used)', async () => {
    // console.atl1: df reports 158G size, 14G used, 137G avail, so the 7G in between is reserved for root (ext4)
    const GB = 1024 ** 3;
    const bsize = 4096;
    const s = readHostStats(
      '/',
      probe({
        statfs: () => ({
          blocks: (158 * GB) / bsize,
          bfree: (144 * GB) / bsize,
          bavail: (137 * GB) / bsize,
          bsize,
        }),
      }),
    );
    const used = (s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes;
    const dfUsePercent = 14 / (14 + 137); // df's own Use%: used / (used + avail)
    expect(used).toBeCloseTo(dfUsePercent, 3);
  });
  it('gives zero disk instead of failing when the path cannot be read', () => {
    const s = readHostStats(
      '/nope',
      probe({
        statfs: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(s.diskTotalBytes).toBe(0);
  });
});

describe('memAvailable', () => {
  it('is null when the line is missing', () => {
    expect(memAvailable('MemTotal: 1 kB')).toBeNull();
    expect(memAvailable(null)).toBeNull();
  });
});

describe('cpuTimes', () => {
  it('counts waiting for the disk as idle, not as work', () => {
    // user nice system idle iowait irq softirq steal
    const t = cpuTimes(
      'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1 1 0 0 0',
    );
    expect(t).toEqual({ busy: 200, total: 1000 });
  });
  it('is null for anything else', () => {
    expect(cpuTimes(null)).toBeNull();
    expect(cpuTimes('nothing')).toBeNull();
  });
});

describe('pressureSome60', () => {
  it('reads the minute average of the "some" line', () => {
    expect(
      pressureSome60(
        'some avg10=1.00 avg60=42.50 avg300=3.00 total=1\nfull avg10=0 avg60=9 avg300=0 total=0',
      ),
    ).toBe(42.5);
    expect(pressureSome60(null)).toBeNull();
  });
});

describe('readHostStats: how busy the processor really is', () => {
  it('reports the busy share and the stall figures when the machine has them', () => {
    const s = readHostStats(
      '/data',
      probe({
        cpuBusy: () => 1.234,
        pressure: (n) =>
          n === 'cpu'
            ? 'some avg10=0 avg60=7.5 avg300=0 total=0'
            : 'some avg10=0 avg60=60 avg300=0 total=0',
      }),
    );
    expect(s.cpuBusyPercent).toBe(1.2);
    expect(s.stalledPercent).toEqual({ cpu: 7.5, io: 60 });
  });
  it('is null, not zero, where they cannot be read', () => {
    const s = readHostStats('/data', probe());
    expect(s.cpuBusyPercent).toBeNull();
    expect(s.stalledPercent).toBeNull();
  });
});
