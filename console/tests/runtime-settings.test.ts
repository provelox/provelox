import { describe, expect, it } from 'vitest';
import {
  joinCommand,
  describeRuntime,
  problemsWith,
  summarizeRuntime,
  splitCommand,
  toForm,
  toPatch,
  type RuntimeSettings,
} from '@/lib/runtime-settings';

describe('splitCommand', () => {
  it('splits on spaces and keeps quoted groups together', () => {
    expect(splitCommand('node server.js --port 80')).toEqual([
      'node',
      'server.js',
      '--port',
      '80',
    ]);
    expect(splitCommand(`sh -c "echo hi there"`)).toEqual([
      'sh',
      '-c',
      'echo hi there',
    ]);
    expect(splitCommand(`a 'b c' d\\ e`)).toEqual(['a', 'b c', 'd e']);
    expect(splitCommand('  ')).toEqual([]);
    expect(splitCommand('a "" b')).toEqual(['a', '', 'b']);
  });

  it('refuses an unclosed quote', () => {
    expect(splitCommand('echo "oops')).toBeNull();
  });

  it('round-trips through joinCommand', () => {
    for (const args of [
      ['node', 'a b', 'c"d'],
      ['sh', '-c', 'echo $HOME && ls'],
      ['x', ''],
    ])
      expect(splitCommand(joinCommand(args))).toEqual(args);
  });
});

const settings: RuntimeSettings = {
  command: ['node', 'server.js'],
  restart: 'on-failure',
  resources: { cpus: 0.5, memoryBytes: 512 * 1024 * 1024 },
  healthcheck: {
    test: ['CMD-SHELL', 'curl -f http://localhost/health'],
    intervalSeconds: 30,
    retries: 3,
  },
};

describe('runtime form', () => {
  it('shows what is set, in the units people use', () => {
    const f = toForm(settings);
    expect(f).toMatchObject({
      command: 'node server.js',
      restart: 'on-failure',
      cpus: '0.5',
      memory: '512',
      memoryUnit: 'MB',
      healthOn: true,
      healthCommand: 'curl -f http://localhost/health',
      interval: '30',
      retries: '3',
    });
    expect(
      toForm({ restart: 'any', resources: { memoryBytes: 2 * 1024 ** 3 } }),
    ).toMatchObject({
      memory: '2',
      memoryUnit: 'GB',
    });
  });

  it('sends back exactly what it was given when nothing changed', () => {
    const p = toPatch(toForm(settings));
    expect(p.command).toEqual(['node', 'server.js']);
    expect(p.resources).toEqual({ cpus: 0.5, memoryBytes: 512 * 1024 * 1024 });
    expect(p.healthcheck).toEqual({
      test: ['CMD-SHELL', 'curl -f http://localhost/health'],
      intervalSeconds: 30,
      retries: 3,
    });
  });

  it('clears a setting back to the image’s own when it is emptied', () => {
    const f = {
      ...toForm(settings),
      command: '',
      cpus: '',
      memory: '',
      healthOn: false,
    };
    const p = toPatch(f);
    expect(p.command).toBeNull();
    expect(p.resources).toBeNull();
    expect(p.healthcheck).toBeNull();
    expect(p.entrypoint).toBeNull();
    expect(p.user).toBeNull();
  });

  it('explains what is wrong in plain words', () => {
    const f = {
      ...toForm({ restart: 'any' }),
      workingDir: 'app',
      cpus: '0',
      memory: '1',
      memoryUnit: 'MB' as const,
      command: 'echo "x',
      healthOn: true,
      retries: '1.5',
    };
    const p = problemsWith(f);
    expect(p.workingDir).toMatch(/absolute/);
    expect(p.cpus).toMatch(/above 0/);
    expect(p.memory).toMatch(/6 MB/);
    expect(p.command).toMatch(/quote/);
    expect(p.healthCommand).toMatch(/command/);
    expect(p.retries).toBeDefined();
    expect(problemsWith(toForm(settings))).toEqual({});
  });
});

describe('summarizeRuntime', () => {
  it('says how it restarts, what it may use and whether it is checked', () => {
    expect(summarizeRuntime({ restart: 'any' })).toEqual([
      { label: 'Restart', value: 'Always' },
      { label: 'Limits', value: 'None' },
      { label: 'Health check', value: 'Off' },
    ]);
    expect(
      summarizeRuntime({
        restart: 'on-failure',
        resources: { cpus: 0.5, memoryBytes: 512 * 1024 * 1024 },
        healthcheck: { test: ['CMD-SHELL', 'true'] },
      }),
    ).toEqual([
      { label: 'Restart', value: 'On failure' },
      { label: 'Limits', value: '0.5 CPU, 512 MB' },
      { label: 'Health check', value: 'On' },
    ]);
  });
});

describe('describeRuntime', () => {
  const s: RuntimeSettings = {
    command: ['redis-server', '--requirepass', 'hunter2'],
    restart: 'any',
    healthcheck: {
      test: ['CMD-SHELL', 'redis-cli -a hunter2 ping'],
      intervalSeconds: 10,
    },
  };
  const text = (reveal: boolean) => JSON.stringify(describeRuntime(s, reveal));

  it('hides command lines unless asked, because they often hold credentials', () => {
    expect(text(false)).not.toContain('hunter2');
    expect(text(true)).toContain('hunter2');
  });

  it('says what is unset instead of leaving it blank', () => {
    const g = describeRuntime({ restart: 'none' }, false);
    expect(g[0].rows[0]).toMatchObject({ value: '', empty: 'Image default' });
    expect(g[1].rows[0]).toMatchObject({ empty: 'Unlimited' });
    expect(g[3].rows[0]).toMatchObject({ empty: 'Off' });
  });
});
