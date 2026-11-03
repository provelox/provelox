import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostFindings, parseHostReport, type HostReport } from './findings';
import { HOST_SCAN_SCRIPT } from './host-scan.script';

/**
 * The real helper script, run with `node -e` against a made-up host: a folder that plays the part of /host, and one
 * that plays /proc. It cannot show that the helper works inside Docker on a real machine, but it does show that what
 * the script reads and prints is what the findings expect.
 */
describe('HOST_SCAN_SCRIPT on a fixture host', () => {
  let root: string;
  let host: string;
  let proc: string;
  const put = (rel: string, text: string | Buffer, mode?: number) => {
    const f = join(host, rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, text);
    if (mode) chmodSync(f, mode);
  };
  const scan = (): HostReport =>
    parseHostReport(
      execFileSync('node', ['-e', HOST_SCAN_SCRIPT], {
        env: {
          PATH: process.env.PATH,
          PVX_HOST: host,
          PVX_PROC: proc,
          PVX_SAMPLE_MS: '30',
        },
        encoding: 'utf8',
      }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pvx-host-'));
    host = join(root, 'host');
    proc = join(root, 'proc');
    mkdirSync(host);
    mkdirSync(proc);
    put(
      'etc/passwd',
      'root:x:0:0::/root:/bin/bash\nnobody:x:65534:65534::/:/usr/sbin/nologin\n',
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports nothing for a plain host', () => {
    const r = scan();
    expect(r.preload).toBeNull();
    expect(r.uid0).toEqual([]);
    expect(r.cron).toEqual([]);
    expect(r.elf).toEqual([]);
    expect(hostFindings(r)).toEqual([]);
  });

  it('sees a preloaded library, a second root account, malware cron jobs and a program in /dev/shm', () => {
    put('etc/ld.so.preload', '/lib/libgcwrap.so');
    put('lib/libgcwrap.so', 'x'.repeat(80));
    put('etc/passwd', 'root:x:0:0::/root:/bin/bash\ntoor:x:0:0::/:/bin/sh\n');
    put('etc/cron.d/perfclean', '9 * * * * root perfcc\n');
    put(
      'var/spool/cron/crontabs/root',
      '# m h\n11 * * * * /root/.config/cron/perfcc\n0 3 * * * /usr/bin/backup\n',
    );
    put(
      'etc/cron.daily/logrotate',
      '#!/bin/sh\n/usr/sbin/logrotate /etc/logrotate.conf\n',
      0o755,
    );
    put('dev/shm/.x/miner', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2]), 0o755);
    put('tmp/notes.sh', '#!/bin/sh\n', 0o755);
    const r = scan();
    expect(r.preload!.entries).toEqual([
      { path: '/lib/libgcwrap.so', exists: true, size: 80 },
    ]);
    expect(r.uid0).toEqual(['toor']);
    const files = r.cron!.map((c) => c.file);
    expect(files).toContain('/etc/cron.d/perfclean');
    expect(files).toContain('/var/spool/cron/crontabs/root');
    expect(r.cron!.every((c) => c.known)).toBe(true);
    expect(r.cron!.some((c) => c.line.includes('logrotate'))).toBe(false);
    expect(r.elf).toEqual(['/dev/shm/.x/miner']);
    const ids = hostFindings(r).map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(['ld-preload', 'uid0-account', 'elf-in-tmp']),
    );
  });

  it('says a library that is not there is missing, rather than failing', () => {
    put('etc/ld.so.preload', '/lib/ghost.so\n');
    expect(scan().preload!.entries[0]).toMatchObject({ exists: false });
  });

  it('reads SSH settings with the .d files first, keys as fingerprints only, and failed sign-ins', () => {
    put('etc/ssh/sshd_config.d/50-cloud.conf', 'PasswordAuthentication no\n');
    put(
      'etc/ssh/sshd_config',
      'Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication yes\nPermitRootLogin yes\n',
    );
    // the real blob of an ed25519 key made up of 51 bytes: only the fingerprint may come out
    const blob = Buffer.from('a'.repeat(51)).toString('base64');
    put('root/.ssh/authorized_keys', `ssh-ed25519 ${blob} me@laptop\n# old\n`);
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const gone = new Date(Date.now() - 10 * 86400_000).toISOString();
    put(
      'var/log/auth.log',
      [
        `${recent} app sshd[1]: Failed password for root from 1.2.3.4 port 1 ssh2`,
        `${recent} app sshd[2]: Failed password for invalid user a from 1.2.3.4 port 2 ssh2`,
        `${old} app sshd[3]: Invalid user bob from 5.6.7.8 port 3`,
        `${gone} app sshd[4]: Failed password for root from 9.9.9.9 port 4 ssh2`,
        `${recent} app sshd[5]: Accepted publickey for root from 7.7.7.7 port 5 ssh2`,
      ].join('\n'),
    );
    const r = scan();
    // the .d file says no first, so passwords are off; root login comes from the main file
    expect(r.sshd).toEqual({ password: 'no', rootLogin: 'yes' });
    expect(r.keys!.list).toHaveLength(1);
    expect(r.keys!.list[0].fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(r.keys!.list[0].comment).toBe('me@laptop');
    expect(JSON.stringify(r)).not.toContain(blob);
    expect(r.keys!.ageDays).toBeLessThan(1);
    expect(r.auth!.failed24h).toBe(3);
    expect(r.auth!.top[0]).toEqual(['1.2.3.4', 2]);
    // an old keys file is not "changed this week"
    const t = new Date(Date.now() - 30 * 86400_000);
    utimesSync(join(host, 'root/.ssh/authorized_keys'), t, t);
    expect(scan().keys!.ageDays).toBeGreaterThan(29);
  });

  it('sees Docker listening on the network, with or without TLS', () => {
    put(
      'etc/docker/daemon.json',
      JSON.stringify({
        hosts: ['unix:///var/run/docker.sock', 'tcp://0.0.0.0:2375'],
      }),
    );
    expect(scan().dockerTcp).toBe(true);
    put(
      'etc/docker/daemon.json',
      JSON.stringify({ hosts: ['tcp://0.0.0.0:2376'], tlsverify: true }),
    );
    expect(scan().dockerTcp).toBe(false);
    put('etc/docker/daemon.json', '{}');
    put(
      'etc/systemd/system/docker.service.d/o.conf',
      '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375\n',
    );
    expect(scan().dockerTcp).toBe(true);
  });

  it('finds processes the cgroups know of that /proc does not list', () => {
    // two live processes in /proc; the cgroup lists five more
    for (const pid of ['11', '12'])
      mkdirSync(join(proc, pid), { recursive: true });
    put(
      'sys/fs/cgroup/system.slice/cgroup.procs',
      '11\n12\n9001\n9002\n9003\n9004\n9005\n',
    );
    expect(scan().cgroupOnly).toBe(5);
  });

  it('treats a dot folder as odd on the machine, but not inside a container, where tools live there', () => {
    const cid = 'a'.repeat(64);
    const proc1 = (pid: string, exe: string, cgroup: string, comm: string) => {
      mkdirSync(join(proc, pid), { recursive: true });
      symlinkSync(exe, join(proc, pid, 'exe'));
      writeFileSync(join(proc, pid, 'cgroup'), cgroup);
      writeFileSync(join(proc, pid, 'comm'), comm + '\n');
    };
    // Puppeteer's Chrome in an app's container: normal
    proc1(
      '21',
      '/root/.cache/puppeteer/chrome/linux-119/chrome',
      `0::/system.slice/docker-${cid}.scope\n`,
      'chrome',
    );
    // The same path on the machine itself: how the miner on lax-1 hid
    proc1(
      '22',
      '/root/.config/cron/perfcc',
      '0::/user.slice/x.scope\n',
      'perfcc',
    );
    // A program run from /tmp inside a container: worth a look, not an alarm
    proc1(
      '23',
      '/tmp/x/node',
      `0::/system.slice/docker-${cid}.scope\n`,
      'node',
    );
    // A dev tool on the machine that lives in a known dot folder: normal
    proc1(
      '24',
      '/root/.vscode-server/bin/abc/node',
      '0::/user.slice/y.scope\n',
      'node',
    );
    const r = scan();
    expect(r.oddProcs).toEqual([
      { name: 'perfcc', exe: '/root/.config/cron/perfcc' },
    ]);
    expect(r.oddCtrProcs).toEqual([
      { name: 'node', exe: '/tmp/x/node', c: 'a'.repeat(12) },
    ]);
  });

  it('keeps its output small enough for the helper to return it whole', () => {
    for (let i = 0; i < 40; i++)
      put(
        `etc/cron.d/j${i}`,
        `* * * * * /root/.hidden${i}/${'x'.repeat(200)}\n`,
      );
    for (let i = 0; i < 40; i++)
      put(`tmp/p${i}`, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0o755);
    const out = execFileSync('node', ['-e', HOST_SCAN_SCRIPT], {
      env: {
        PATH: process.env.PATH,
        PVX_HOST: host,
        PVX_PROC: proc,
        PVX_SAMPLE_MS: '10',
      },
      encoding: 'utf8',
    });
    expect(out.length).toBeLessThan(16_000);
  });
});
