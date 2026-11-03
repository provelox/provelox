import { instanceUsage, totalUsage } from './usage';

describe('instanceUsage', () => {
  it('reads CPU like `docker stats`: share of the machine times its cores', () => {
    const u = instanceUsage({
      cpu_stats: {
        cpu_usage: { total_usage: 600 },
        system_cpu_usage: 10_000,
        online_cpus: 4,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 200 },
        system_cpu_usage: 8_000,
      },
      memory_stats: {
        usage: 100 * 1024 ** 2,
        stats: { inactive_file: 20 * 1024 ** 2 },
      },
    });
    // (400 / 2000) * 4 cores * 100
    expect(u.cpuPercent).toBe(80);
    expect(u.memoryBytes).toBe(80 * 1024 ** 2);
  });

  it('subtracts the file cache on cgroup v1 too', () => {
    expect(
      instanceUsage({ memory_stats: { usage: 1000, stats: { cache: 400 } } })
        .memoryBytes,
    ).toBe(600);
  });

  it('says zero rather than nonsense when a sample is empty or goes backwards', () => {
    expect(instanceUsage({})).toEqual({ cpuPercent: 0, memoryBytes: 0 });
    expect(
      instanceUsage({
        cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 5 },
        precpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 50 },
        memory_stats: { usage: 10, stats: { inactive_file: 99 } },
      }),
    ).toEqual({ cpuPercent: 0, memoryBytes: 0 });
  });
});

describe('totalUsage', () => {
  it('adds the instances up', () => {
    expect(
      totalUsage([
        { cpuPercent: 10.5, memoryBytes: 100 },
        { cpuPercent: 4.5, memoryBytes: 50 },
      ]),
    ).toEqual({ instances: 2, cpuPercent: 15, memoryBytes: 150 });
    expect(totalUsage([])).toEqual({
      instances: 0,
      cpuPercent: 0,
      memoryBytes: 0,
    });
  });
});
