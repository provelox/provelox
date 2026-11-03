import { runWizard, type Store, type Ui, type WizardDeps } from './wizard';
import { app, withData, withPorts } from './test-apps';

const apps = [app({ name: 'web' }), withData('db')];

function setup(
  opts: {
    answers?: (string | boolean)[];
    breakVerify?: boolean;
    sourceApps?: ReturnType<typeof app>[];
    published?: string[];
    services?: { name: string; replicas: number }[];
  } = {},
) {
  const log: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const said: string[] = [];
  const ui: Ui = {
    say: (t) => void said.push(t),
    confirm: async (q) => {
      const a = answers.shift();
      log.push(`confirm: ${q.trim().slice(0, 40)} -> ${a}`);
      return a === true;
    },
    typed: async (q, word) => {
      const a = answers.shift();
      log.push(`typed ${word} -> ${a}`);
      return a === word;
    },
  };
  let state: { completed: string[]; moved?: string[] } = { completed: [] };
  const store: Store = {
    load: () => ({ completed: [...state.completed] }),
    save: (s) => void (state = s),
  };
  const migrated = { v: false };
  const d: WizardDeps = {
    sourceTitle: 'OldPaaS',
    apps: opts.sourceApps ?? apps,
    ui,
    store,
    importDeps: {
      api: async (m, p) => void log.push(`api ${m} ${p}`),
      appExists: async () => false,
      volumeExists: async () => true,
      createVolume: async () => undefined,
      runHelper: async () => ({ exitCode: 0, output: '' }),
      helperImage: 'busybox',
      log: () => undefined,
    },
    cutoverDeps: {
      stopOld: async (a) => {
        log.push(`old stop ${a}`);
        return { restore: async () => undefined };
      },
      waitStopped: async () => undefined,
      api: async (m, p) => void log.push(`api ${m} ${p}`),
      getApp: async () => ({ instanceCount: 0, ports: [], pendingPorts: [] }),
      runHelper: async () => ({ exitCode: 0, output: '' }),
      helperImage: 'busybox',
      log: () => undefined,
    },
    verify: {
      getApp: async (name) => ({
        app: {
          name,
          image:
            name === 'web'
              ? 'nginx:1'
              : name === 'dns'
                ? 'a/b:1'
                : 'postgres:16',
          instanceCount: 1,
          exposed: true,
          aliases: [`old-${name}`],
          ports: opts.published?.includes(name)
            ? [
                { hostPort: 53, protocol: 'tcp' },
                { hostPort: 53, protocol: 'udp' },
              ]
            : [],
          pendingPorts: [],
          volumes: [],
        },
        status:
          migrated.v && !opts.breakVerify
            ? { state: 'running', running: 1, desired: 1 }
            : { state: 'stopped', running: 0, desired: 0 },
      }),
      volumeExists: async () => true,
      http: async () => 200,
    },
    appUrl: (a) => `http://${a}.x.test`,
    startApp: async (a, n) => void log.push(`start ${a} ${n}`),
    takeStandardPorts: async () => {
      migrated.v = true;
      log.push('standard ports');
    },
    runtime: {
      stopApp: async (a) => {
        log.push(`old stop ${a}`);
        return { restore: async () => undefined };
      },
      waitStopped: async () => undefined,
      stopProxy: async () => void log.push('stop proxy'),
      services: async () =>
        opts.services ?? [
          { name: 'old-web', replicas: 1 },
          { name: 'old-dashboard', replicas: 1 },
        ],
      stopService: async (n) => void log.push(`stop ${n}`),
      removeService: async (n) => void log.push(`remove ${n}`),
    },
    settle: async () => undefined,
  };
  return { d, log, said, getState: () => state };
}

describe('migration wizard', () => {
  it('stops at the first stage when the answer is no, and changes nothing', async () => {
    const { d, log, getState } = setup({ answers: [false] });
    expect(await runWizard(d)).toBe('paused');
    expect(getState().completed).toEqual([]);
    expect(log.some((l) => l.startsWith('api'))).toBe(false);
  });

  it('goes through every stage with acknowledgements, only touching the services of the old platform', async () => {
    const { d, log, getState } = setup({
      answers: [
        true,
        true,
        true,
        true,
        'cutover',
        true,
        true,
        true,
        'remove oldpaas',
      ],
    });
    expect(await runWizard(d)).toBe('finished');
    expect(getState().completed).toEqual([
      'inventory',
      'import',
      'test',
      'cutover',
      'verify',
      'retire',
      'remove',
    ]);
    expect(log).toContain('stop proxy');
    expect(log).toContain('standard ports');
    expect(log).toContain('remove old-dashboard');
    // the old proxy only stops after the apps moved
    expect(log.indexOf('stop proxy')).toBeGreaterThan(
      log.indexOf('old stop db'),
    );
  });

  it('will not cut over unless the word is typed', async () => {
    const { d, log, getState } = setup({
      answers: [true, true, true, true, 'yes'],
    });
    expect(await runWizard(d)).toBe('paused');
    expect(getState().completed).toEqual(['inventory', 'import', 'test']);
    expect(log).not.toContain('stop proxy');
  });

  it('resumes where it stopped instead of starting over', async () => {
    const first = setup({ answers: [true, true, true, true, 'no'] });
    await runWizard(first.d);
    const apiCallsBefore = first.log.filter(
      (l) => l === 'api POST /v1/apps',
    ).length;
    // same store, new run
    const second = setup({ answers: [] });
    second.d.store.save(first.getState());
    second.d.ui = {
      ...second.d.ui,
      confirm: async () => false,
      typed: async () => false,
    };
    expect(await runWizard(second.d)).toBe('paused');
    expect(second.log.some((l) => l === 'api POST /v1/apps')).toBe(false);
    expect(apiCallsBefore).toBeGreaterThan(0);
  });

  it('leaves an app alone that already moved, even when its progress file was lost', async () => {
    const { d, log } = setup({
      sourceApps: [withPorts('dns'), withData('db')],
      published: ['dns'],
      // inventory, import, start db to try it, move on, cutover
      answers: [true, true, true, true, 'cutover'],
    });
    await runWizard(d);
    expect(log).toContain('old stop db');
    expect(log).not.toContain('old stop dns');
  });

  it('remembers each app as soon as it has moved', async () => {
    const { d, getState } = setup({
      sourceApps: [withData('db')],
      answers: [true, true, true, true, 'cutover'],
    });
    await runWizard(d);
    expect(getState().moved).toEqual(['db']);
  });

  it('stops after the cutover when a check fails, and does not retire the old platform', async () => {
    const { d, log, getState } = setup({
      breakVerify: true,
      answers: [true, true, true, true, 'cutover'],
    });
    expect(await runWizard(d)).toBe('paused');
    expect(getState().completed).toEqual([
      'inventory',
      'import',
      'test',
      'cutover',
    ]);
    expect(log.some((l) => l.startsWith('remove '))).toBe(false);
  });

  it('can leave the removal for later', async () => {
    const { d, getState } = setup({
      answers: [true, true, true, true, 'cutover', true, true, true, false],
    });
    expect(await runWizard(d)).toBe('paused');
    expect(getState().completed).toContain('retire');
    expect(getState().completed).not.toContain('remove');
  });
});
