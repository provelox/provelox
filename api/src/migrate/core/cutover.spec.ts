import { planImport } from './import';
import { planCutover, runCutover, type CutoverDeps } from './cutover';
import { app, withData, withPorts } from './test-apps';

const plans = planImport([
  app({ name: 'web' }),
  withData('db'),
  withPorts('dns'),
]);

describe('cutover plan', () => {
  it('only moves apps with data or host ports', () => {
    const steps = planCutover(plans);
    expect(steps.map((s) => s.app)).toEqual(['db', 'dns']);
    expect(steps[1].publishPorts).toHaveLength(2);
  });
});

describe('runCutover', () => {
  const steps = planCutover(plans);
  function deps(over: Partial<CutoverDeps> = {}) {
    const calls: string[] = [];
    const d: CutoverDeps = {
      stopOld: async (a) => {
        calls.push(`old stop ${a}`);
        return { restore: async () => void calls.push(`old restore ${a}`) };
      },
      waitStopped: async (a, p) => void calls.push(`stopped ${p} ${a}`),
      api: async (m, p, b) => void calls.push(`${m} ${p} ${JSON.stringify(b)}`),
      getApp: async () => ({ instanceCount: 1, ports: [], pendingPorts: [] }),
      runHelper: async (s) => {
        calls.push(`copy ${s.mounts[0].volume} ro=${s.mounts[0].readOnly}`);
        return { exitCode: 0, output: '' };
      },
      helperImage: 'busybox',
      log: () => undefined,
      ...over,
    };
    return { d, calls };
  }

  it('stops both sides, copies, then publishes ports and starts', async () => {
    const { d, calls } = deps();
    const r = await runCutover(steps, d);
    expect(r.done).toEqual(['db', 'dns']);
    expect(calls.slice(0, 6)).toEqual([
      'old stop db',
      'stopped old db',
      'PATCH /v1/apps/db {"instanceCount":0}',
      'stopped provelox db',
      'copy old--db-data ro=true',
      'PATCH /v1/apps/db {"instanceCount":1}',
    ]);
    expect(
      calls.some(
        (c) =>
          c.startsWith('PATCH /v1/apps/dns {"ports":[{') &&
          c.includes('"pendingPorts":[]'),
      ),
    ).toBe(true);
  });

  it('starts the old app again when a copy fails, and stops the run', async () => {
    const { d, calls } = deps({
      runHelper: async () => ({ exitCode: 1, output: 'diff: x' }),
    });
    const r = await runCutover(steps, d);
    expect(r.failed?.app).toBe('db');
    expect(r.done).toEqual([]);
    expect(r.restored).toEqual(['db']);
    expect(calls).toContain('old restore db');
    expect(calls.some((c) => c.includes('dns'))).toBe(false);
  });
});
