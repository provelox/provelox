import { PlatformUsageService } from '../system/platform-usage.service';
import { makeStack } from '../test-utils';
import { SCAN_FRESH_MS, SecurityService } from './security.service';

const clean = JSON.stringify({
  preload: null,
  uid0: [],
  cgroupOnly: 0,
  cron: [],
  elf: [],
  sshd: { password: 'no', rootLogin: 'no' },
});

function setup() {
  const s = makeStack();
  s.docker.self = 'ghcr.io/provelox/provelox:test';
  s.docker.helperResult = { exitCode: 0, output: `${clean}\n` };
  const svc = new SecurityService(
    s.docker,
    s.repo,
    s.apps,
    new PlatformUsageService(s.docker),
    s.cfg,
  );
  return { s, svc };
}

describe('SecurityService', () => {
  it('starts one read-only helper with the host mounted, and reports a clean machine as clean', async () => {
    const { s, svc } = setup();
    const scan = await svc.scan();
    expect(scan.hostChecked).toBe(true);
    expect(scan.findings).toEqual([]);
    expect(s.docker.helperRuns).toHaveLength(1);
    expect(s.docker.helperRuns[0]).toMatchObject({
      hostPid: true,
      hostRoot: true,
      entrypoint: ['node'],
      mounts: [],
    });
    expect(svc.summary()).toMatchObject({ critical: 0, warning: 0 });
  });

  it('puts the worst first, from apps and from the host', async () => {
    const { s, svc } = setup();
    await s.apps.create({ name: 'db', persistent: true });
    await s.apps.update('db', {
      ports: [{ containerPort: 5432, hostPort: 886 }],
    });
    s.docker.helperResult = {
      exitCode: 0,
      output: JSON.stringify({
        preload: {
          size: 17,
          entries: [{ path: '/lib/libgcwrap.so', exists: true, size: 1 }],
        },
        sshd: { password: 'yes', rootLogin: null },
      }),
    };
    const scan = await svc.scan(true);
    expect(scan.findings.map((f) => f.severity)).toEqual([
      'critical',
      'critical',
      'warning',
    ]);
    expect(scan.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining(['exposed-port:db', 'ld-preload', 'ssh-password']),
    );
    expect(svc.summary()).toMatchObject({ critical: 2, warning: 1 });
    const named = svc.summary()!.findings;
    expect(named).toHaveLength(3);
    expect(named.map((f) => f.severity)).toEqual([
      'critical',
      'critical',
      'warning',
    ]);
    // names only: the detail stays on the machine's own console
    expect(Object.keys(named[0]).sort()).toEqual(['id', 'severity', 'title']);
  });

  it('still answers about the apps when the host cannot be looked at, and says why', async () => {
    const { s, svc } = setup();
    s.docker.helperResult = { exitCode: 1, output: '' };
    const scan = await svc.scan(true);
    expect(scan.hostChecked).toBe(false);
    expect(scan.hostError).toMatch(/exited with 1/);
    s.docker.self = null;
    expect((await svc.scan(true)).hostError).toMatch(/which image/);
  });

  it('serves a recent scan again, until it is asked to look afresh', async () => {
    const { s, svc } = setup();
    const t = Date.now();
    await svc.scan(false, t);
    await svc.scan(false, t + SCAN_FRESH_MS - 1);
    expect(s.docker.helperRuns).toHaveLength(1);
    await svc.scan(false, Date.now() + SCAN_FRESH_MS + 1000);
    expect(s.docker.helperRuns).toHaveLength(2);
    await svc.scan(true);
    expect(s.docker.helperRuns).toHaveLength(3);
  });

  it('takes one scan at a time however many ask', async () => {
    const { s, svc } = setup();
    await Promise.all([svc.scan(true), svc.scan(true), svc.scan(true)]);
    expect(s.docker.helperRuns).toHaveLength(1);
  });

  it('has nothing to say before the first scan, and a summary never starts one', () => {
    const { s, svc } = setup();
    expect(svc.latest()).toBeNull();
    expect(svc.summary()).toBeNull();
    expect(s.docker.helperRuns).toHaveLength(0);
  });
});
