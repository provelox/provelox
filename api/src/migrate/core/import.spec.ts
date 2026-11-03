import { formatPlan, planImport, runImport, type ImportDeps } from './import';
import { app, withData, withPorts } from './test-apps';

describe('import plan', () => {
  const plans = planImport([
    app({ name: 'web', instanceCount: 2 }),
    withData('db'),
    withPorts('dns'),
    app({ name: 'bad', blocker: 'Built on the server.' }),
  ]);
  const by = (n: string) => plans.find((p) => p.name === n)!;

  it('keeps instances and the old name as an alias', () => {
    expect(by('web').patch.instanceCount).toBe(2);
    expect(by('web').patch.aliases).toEqual(['old-web']);
  });

  it('creates apps with data or host ports stopped, and copies the data', () => {
    expect(by('db').patch.instanceCount).toBe(0);
    expect(by('db').persistent).toBe(true);
    expect(by('db').copies).toEqual([
      { from: 'old--db-data', to: 'pvx-db-db-data', containerPath: '/data' },
    ]);
    expect(by('dns').patch.instanceCount).toBe(0);
  });

  it('holds host ports back, because Swarm refuses a duplicate even at zero instances', () => {
    expect(by('dns').patch.ports).toEqual([]);
    expect(by('dns').patch.pendingPorts).toHaveLength(2);
  });

  it('skips an app the source cannot hand over', () => {
    expect(by('bad').skip).toMatch(/Built/);
  });
});

describe('import plan with HTTP basic auth', () => {
  const hash = '$2a$10$' + 'd'.repeat(53);

  it('carries the password protection over', () => {
    const [p] = planImport([
      app({ name: 'admin', httpAuth: { user: 'secure', hash } }),
    ]);
    expect(p.patch.basicAuth).toEqual({
      users: [{ name: 'secure', hash }],
      openPaths: [],
    });
    expect(p.startStopped).toBe(false);
    expect(formatPlan([p])).toMatch(
      /password\s+HTTP basic auth carried over for secure/,
    );
  });

  it('creates the app stopped when its password could not be carried, so it is never public without it', () => {
    const [p] = planImport([
      app({ name: 'admin', httpAuth: { user: 'secure' } }),
    ]);
    expect(p.patch.basicAuth).toBeUndefined();
    expect(p.startStopped).toBe(true);
    expect(p.patch.instanceCount).toBe(0);
    expect(p.warnings.join(' ')).toMatch(/Created stopped.*password/);
  });
});

describe('runImport', () => {
  function deps(over: Partial<ImportDeps> = {}) {
    const calls: string[] = [];
    const d: ImportDeps = {
      api: async (m, p) => void calls.push(`${m} ${p}`),
      appExists: async (n) => n === 'web',
      volumeExists: async (n) => n.startsWith('old--'),
      createVolume: async (n) => void calls.push(`volume ${n}`),
      runHelper: async (s) => {
        expect(s.command.join(' ')).toContain('find /to -mindepth 1 -delete');
        calls.push(`copy ${s.mounts[0].volume} ro=${s.mounts[0].readOnly}`);
        return { exitCode: 0, output: '' };
      },
      helperImage: 'busybox',
      log: () => undefined,
      ...over,
    };
    return { d, calls };
  }
  const plans = planImport([
    app({ name: 'web' }),
    withData('db'),
    withPorts('dns'),
  ]);

  it('creates, copies read-only, configures, then deploys; leaves existing apps alone', async () => {
    const { d, calls } = deps();
    const r = await runImport(plans, d);
    expect(r.imported).toEqual(['db', 'dns']);
    expect(r.skipped.map((s) => s.name)).toEqual(['web']);
    expect(
      calls.slice(0, calls.indexOf('POST /v1/apps/db/deploy') + 1),
    ).toEqual([
      'POST /v1/apps',
      'volume pvx-db-db-data',
      'copy old--db-data ro=true',
      'PATCH /v1/apps/db',
      'POST /v1/apps/db/deploy',
    ]);
  });

  it('carries on, with a note, when files differ because the source was running', async () => {
    const logs: string[] = [];
    const { d } = deps({
      runHelper: async () => ({
        exitCode: 0,
        output:
          'Files /from/pg_stat_tmp/a.stat and /to/pg_stat_tmp/a.stat differ\nFiles /from/pg_stat_tmp/b.stat and /to/pg_stat_tmp/b.stat differ\n',
      }),
      log: (m) => void logs.push(m),
    });
    const r = await runImport(plans, d);
    expect(r.failed).toEqual([]);
    expect(r.imported).toContain('db');
    expect(logs.some((l) => /2 files changed while copying/.test(l))).toBe(
      true,
    );
  });

  it('reports a failed copy and carries on with the other apps', async () => {
    const { d } = deps({
      runHelper: async () => ({ exitCode: 3, output: 'cp: no space left' }),
    });
    const r = await runImport(plans, d);
    expect(r.failed.map((f) => f.name)).toEqual(['db']);
    expect(r.failed[0].reason).toMatch(/Copying old--db-data failed/);
    expect(r.imported).toEqual(['dns']);
  });

  it('takes away an app it could not finish, so running the import again redoes it', async () => {
    const calls: string[] = [];
    const { d } = deps({
      appExists: async () => false,
      api: async (m, p) => {
        calls.push(`${m} ${p}`);
        if (m === 'PATCH') throw new Error('refused');
      },
    });
    const r = await runImport(planImport([app({ name: 'api2' })]), d);
    expect(r.failed).toEqual([{ name: 'api2', reason: 'refused' }]);
    expect(calls).toEqual([
      'POST /v1/apps',
      'PATCH /v1/apps/api2',
      'DELETE /v1/apps/api2',
    ]);
  });

  it('finishes an app an earlier import left without its settings, and leaves a finished one alone', async () => {
    const calls: string[] = [];
    const plan = planImport([app({ name: 'half' }), app({ name: 'done' })]);
    const { d } = deps({
      appExists: async () => true,
      appAliases: async (n) => (n === 'done' ? ['old-done'] : []),
      api: async (m, p) => void calls.push(`${m} ${p}`),
    });
    const r = await runImport(plan, d);
    expect(r.imported).toEqual(['half']);
    expect(r.skipped.map((s) => s.name)).toEqual(['done']);
    expect(calls).toContain('PATCH /v1/apps/half');
    expect(
      calls.some((c) => c.includes('POST /v1/apps ') || c === 'POST /v1/apps'),
    ).toBe(false);
  });
});
