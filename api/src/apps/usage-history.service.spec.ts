import { makeStack } from '../test-utils';
import { UsageHistoryService } from './usage-history.service';

const MIN = 60_000;

async function setup(env: Record<string, string> = {}) {
  const s = makeStack(env);
  const history = new UsageHistoryService(s.db, s.apps, s.cfg);
  await s.apps.create({ name: 'site' });
  s.apps.usageCacheMs = 0; // every sample reads fresh
  const reading = (cpu: number, mem: number) =>
    s.docker.usage.set('pvx-site', {
      instances: 1,
      cpuPercent: cpu,
      memoryBytes: mem,
    });
  return { ...s, history, reading };
}

describe('UsageHistoryService', () => {
  it('stores what running apps use and gives it back oldest first', async () => {
    const { history, reading } = await setup();
    const t0 = Date.UTC(2026, 9, 15, 12, 0);
    reading(10, 100);
    await history.sample(t0);
    reading(30, 300);
    await history.sample(t0 + MIN);
    const points = history.history('site', 60, t0 + 2 * MIN);
    expect(points.map((p) => [p.cpu, p.mem])).toEqual([
      [10, 100],
      [30, 300],
    ]);
    expect(points[0].t).toBe(t0);
  });

  it('leaves a stopped app out, and says nothing for an app with no samples', async () => {
    const { history, apps } = await setup();
    await apps.update('site', { instanceCount: 0 });
    await history.sample(Date.UTC(2026, 9, 15));
    expect(history.history('site', 60, Date.UTC(2026, 9, 15, 0, 1))).toEqual(
      [],
    );
    expect(history.history('nope', 60)).toEqual([]);
  });

  it('only looks back as far as asked, and never further than it keeps', async () => {
    const { history, reading } = await setup({ USAGE_RETENTION_HOURS: '1' });
    const now = Date.UTC(2026, 9, 15, 12, 0);
    reading(1, 1);
    await history.sample(now - 50 * MIN);
    reading(2, 2);
    await history.sample(now - 5 * MIN);
    expect(history.history('site', 10, now).map((p) => p.cpu)).toEqual([2]);
    // asking for a day gets only the hour that is kept
    expect(history.history('site', 24 * 60, now).map((p) => p.cpu)).toEqual([
      1, 2,
    ]);
  });

  it('averages a long span into at most 120 points', async () => {
    const { history, reading } = await setup();
    const now = Date.UTC(2026, 9, 15, 12, 0);
    for (let i = 0; i < 480; i++) {
      reading(i % 2 === 0 ? 10 : 20, 100);
      await history.sample(now - (480 - i) * MIN);
    }
    const points = history.history('site', 24 * 60, now);
    // a day is cut into 12 minute buckets: 480 samples become 40 points, each the average of its neighbours
    expect(points.length).toBeLessThanOrEqual(120);
    expect(points).toHaveLength(40);
    for (const p of points) expect(p.cpu).toBeGreaterThan(14);
    for (const p of points) expect(p.cpu).toBeLessThan(16);
  });

  it('drops samples older than the retention, and those of apps that are gone', async () => {
    const { history, reading, apps, db } = await setup({
      USAGE_RETENTION_HOURS: '1',
    });
    const now = Date.UTC(2026, 9, 15, 12, 0);
    reading(5, 5);
    await history.sample(now - 3 * 60 * MIN);
    await history.sample(now - 10 * MIN);
    history.prune(now);
    expect(history.history('site', 60, now)).toHaveLength(1);
    await apps.remove('site');
    history.prune(now);
    const left = db.raw
      .prepare('SELECT COUNT(*) AS n FROM usage_samples')
      .get() as { n: number };
    expect(left.n).toBe(0);
  });
});
