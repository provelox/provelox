import {
  exposedPortFindings,
  hostFindings,
  parseHostReport,
  unaccountedCpuFinding,
  type HostReport,
} from './findings';

describe('exposedPortFindings', () => {
  it('calls a database published to everyone critical, by its port', () => {
    const [f] = exposedPortFindings([
      {
        name: 'db-track',
        image: 'x/y:1',
        ports: [{ hostPort: 886, containerPort: 5432 }],
      },
    ]);
    expect(f).toMatchObject({
      id: 'exposed-port:db-track',
      severity: 'critical',
    });
    expect(f.title).toMatch(/PostgreSQL/);
    expect(f.detail).toMatch(/886/);
  });
  it('knows a database by its image when the port is unusual', () => {
    const [f] = exposedPortFindings([
      {
        name: 'cache',
        image: 'docker.io/library/redis:7',
        ports: [{ hostPort: 7777, containerPort: 7777 }],
      },
    ]);
    expect(f.severity).toBe('critical');
  });
  it('flags the Docker API and ignores ordinary ports', () => {
    expect(
      exposedPortFindings([
        {
          name: 'web',
          image: 'nginx',
          ports: [{ hostPort: 8080, containerPort: 80 }],
        },
        { name: 'none', image: 'redis:7', ports: [] },
      ]),
    ).toEqual([]);
    const [f] = exposedPortFindings([
      {
        name: 'x',
        image: 'a/b',
        ports: [{ hostPort: 2375, containerPort: 2375 }],
      },
    ]);
    expect(f.title).toMatch(/Docker API/);
  });
  it('does not mistake an image that only contains the letters', () => {
    expect(
      exposedPortFindings([
        {
          name: 'a',
          image: 'ghcr.io/acme/redisplay:1',
          ports: [{ hostPort: 9999, containerPort: 80 }],
        },
      ]),
    ).toEqual([]);
  });
});

describe('unaccountedCpuFinding', () => {
  it('says so when the machine is busy and the apps explain little of it', () => {
    const f = unaccountedCpuFinding({
      hostBusyPercent: 97,
      cpus: 4,
      knownPercentOfCores: 28, // 7% of the machine
    });
    expect(f).toMatchObject({ id: 'cpu-unaccounted', severity: 'critical' });
    expect(f!.detail).toMatch(/97%/);
  });
  it('is quiet when the apps account for the work, the machine is calm, or nothing is known', () => {
    expect(
      unaccountedCpuFinding({
        hostBusyPercent: 80,
        cpus: 4,
        knownPercentOfCores: 300,
      }),
    ).toBeNull();
    expect(
      unaccountedCpuFinding({
        hostBusyPercent: 20,
        cpus: 4,
        knownPercentOfCores: 0,
      }),
    ).toBeNull();
    expect(
      unaccountedCpuFinding({
        hostBusyPercent: null,
        cpus: 4,
        knownPercentOfCores: 0,
      }),
    ).toBeNull();
  });
});

describe('hostFindings', () => {
  it('is empty for a clean report', () => {
    expect(
      hostFindings({
        preload: null,
        uid0: [],
        cgroupOnly: 0,
        oddProcs: [],
        oddProcCount: 0,
        cron: [],
        elf: [],
        sshd: { password: 'no', rootLogin: 'prohibit-password' },
        keys: null,
        auth: null,
        dockerTcp: false,
        hostBusy: [],
      }),
    ).toEqual([]);
  });

  it('finds what lax-1 had: a preloaded library and a hidden job and processes', () => {
    const r: HostReport = {
      preload: {
        size: 17,
        entries: [{ path: '/lib/libgcwrap.so', exists: true, size: 80800 }],
      },
      cgroupOnly: 7,
      cron: [
        {
          file: '/etc/cron.d/perfclean',
          line: '9 * * * * root perfcc',
          known: true,
        },
        {
          file: '/var/spool/cron/crontabs/root',
          line: '11 * * * * /root/.config/cron/perfcc',
          known: true,
        },
      ],
    };
    const f = hostFindings(r);
    expect(f.map((x) => x.id)).toEqual(
      expect.arrayContaining(['ld-preload', 'hidden-processes']),
    );
    expect(
      f.filter((x) => x.id.startsWith('cron:') && x.severity === 'critical'),
    ).toHaveLength(2);
    expect(f.find((x) => x.id === 'ld-preload')!.detail).toMatch(/libgcwrap/);
  });

  it('puts a few missing processes down to chance, but not three', () => {
    expect(hostFindings({ cgroupOnly: 2 })).toEqual([]);
    expect(hostFindings({ cgroupOnly: 3 })[0].id).toBe('hidden-processes');
  });

  it('only warns about a job from a hidden place that is not known malware', () => {
    const [f] = hostFindings({
      cron: [
        {
          file: '/etc/cron.d/x',
          line: '* * * * * /root/.local/run.sh',
          known: false,
        },
      ],
    });
    expect(f.severity).toBe('warning');
  });

  it('reads SSH settings, keys and failed sign-ins', () => {
    const f = hostFindings({
      sshd: { password: 'yes', rootLogin: 'yes' },
      keys: {
        ageDays: 0.5,
        list: [{ type: 'ssh-ed25519', fp: 'SHA256:abc', comment: 'me@laptop' }],
      },
      auth: { failed24h: 4012, top: [['1.2.3.4', 900]] },
    });
    expect(f.find((x) => x.id === 'ssh-password')!.severity).toBe('warning');
    expect(f.find((x) => x.id === 'ssh-keys')!.detail).toMatch(/SHA256:abc/);
    expect(f.find((x) => x.id === 'ssh-keys-changed')!.title).toMatch(/today/);
    expect(f.find((x) => x.id === 'ssh-failed')).toMatchObject({
      severity: 'info',
    });
    // an old key file is only listed
    const old = hostFindings({
      keys: {
        ageDays: 90,
        list: [{ type: 'ssh-rsa', fp: 'SHA256:z', comment: '' }],
      },
    });
    expect(old.map((x) => x.id)).toEqual(['ssh-keys']);
  });

  it('names the app for a program that runs from a temporary place inside a container, as a warning', () => {
    const f = hostFindings(
      {
        oddCtrProcCount: 1,
        oddCtrProcs: [{ name: 'node', exe: '/tmp/x/node', c: 'abc123def456' }],
      },
      { abc123def456: 'pvx-shop' },
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      id: 'odd-processes-in-container',
      severity: 'warning',
    });
    expect(f[0].detail).toContain('node in shop (/tmp/x/node)');
  });

  it('flags Docker on the network without TLS, a second root account and odd processes', () => {
    const f = hostFindings({
      dockerTcp: true,
      uid0: ['toor'],
      oddProcCount: 2,
      oddProcs: [{ name: 'kworkerds', exe: '/dev/shm/.x/kworkerds (deleted)' }],
      hostBusy: [{ name: 'xmrig', cpu: 380 }],
    });
    expect(f.map((x) => x.id)).toEqual(
      expect.arrayContaining([
        'docker-tcp',
        'uid0-account',
        'odd-processes',
        'host-busy:0:xmrig',
      ]),
    );
    expect(f.filter((x) => x.severity === 'critical')).toHaveLength(3);
  });
});

describe('parseHostReport', () => {
  it('takes the last line of JSON', () => {
    expect(parseHostReport('noise\n{"uid0":["a"]}\n')).toEqual({ uid0: ['a'] });
    expect(() => parseHostReport('nothing')).toThrow(/no reading/);
  });
});
