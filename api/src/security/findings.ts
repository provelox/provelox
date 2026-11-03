/** One thing the security check noticed. `id` is stable, so the console and the hub can tell the same finding again. */
export interface Finding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  /** What to do about it, in a sentence or two */
  fix?: string;
}

export interface SecurityScan {
  /** ISO time of the scan */
  at: string;
  findings: Finding[];
  /** Whether the host could be looked at (a helper container is needed); without it only the app checks ran */
  hostChecked: boolean;
  /** Why the host could not be looked at */
  hostError?: string;
}

const order = { critical: 0, warning: 1, info: 2 } as const;
export const bySeverity = (a: Finding, b: Finding) =>
  order[a.severity] - order[b.severity];

/** Counts by severity, for the summary other systems read. */
export function countFindings(findings: Finding[]) {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Apps: what is published to the whole internet that should not be

/** Ports of databases and other services that were never meant to face the internet. */
const DATABASE_PORTS: Record<number, string> = {
  3306: 'MySQL or MariaDB',
  5432: 'PostgreSQL',
  5433: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
  9200: 'Elasticsearch',
  9300: 'Elasticsearch',
  11211: 'Memcached',
  5984: 'CouchDB',
  9042: 'Cassandra',
  1433: 'SQL Server',
  8086: 'InfluxDB',
  5672: 'RabbitMQ',
};
/** Docker's own API: whoever reaches it controls the machine. */
const DOCKER_API_PORTS = [2375, 2376];
const ADMIN_PORTS: Record<number, string> = {
  15672: 'the RabbitMQ admin page',
};
const DATABASE_IMAGE =
  /(^|[/:_-])(postgres(ql)?|mysql|mariadb|mongo(db)?|redis|valkey|elasticsearch|opensearch|memcached|couchdb|cassandra|influxdb|clickhouse)([/:_-]|$)/i;

export interface PublishingApp {
  name: string;
  image: string;
  ports: { hostPort: number; containerPort: number; protocol?: string }[];
}

/**
 * An app that publishes a port, publishes it on every address of every machine in the Swarm (Docker also bypasses the
 * machine's own firewall for published ports). For a database that is how most break-ins start.
 */
export function exposedPortFindings(apps: PublishingApp[]): Finding[] {
  const out: Finding[] = [];
  for (const a of apps) {
    if (a.ports.length === 0) continue;
    const dbImage = DATABASE_IMAGE.test(a.image);
    const kinds = new Set<string>();
    let critical = dbImage;
    for (const p of a.ports) {
      const known =
        DATABASE_PORTS[p.containerPort] ?? DATABASE_PORTS[p.hostPort];
      if (known) {
        kinds.add(known);
        critical = true;
      }
      if (
        DOCKER_API_PORTS.includes(p.containerPort) ||
        DOCKER_API_PORTS.includes(p.hostPort)
      ) {
        kinds.add('the Docker API');
        critical = true;
      }
      const admin = ADMIN_PORTS[p.containerPort] ?? ADMIN_PORTS[p.hostPort];
      if (admin) kinds.add(admin);
    }
    if (!critical && kinds.size === 0) continue;
    const ports = a.ports
      .map((p) => `${p.hostPort}${p.protocol === 'udp' ? '/udp' : ''}`)
      .join(', ');
    const what = [...kinds].join(' and ') || (dbImage ? 'a database' : '');
    out.push({
      id: `exposed-port:${a.name}`,
      severity: critical ? 'critical' : 'warning',
      title: `${a.name} publishes ${what} to the internet`,
      detail: `Port ${ports} is open on every address of the server, so anyone on the internet can try to reach ${what}. Docker opens published ports past the machine's own firewall (ufw does not stop them). Databases open to the internet are a common way servers get taken over.`,
      fix: 'Remove the published port from the app (Networking → Ports). Other apps reach it by its name on the private network, and you can still connect from your own machine through an SSH tunnel. If it must stay open, allow only your own addresses in your provider’s firewall.',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The processor: work nothing Provelox runs accounts for

export interface CpuAccount {
  /** The share of the whole machine's processor that was working, 0 to 100. Null when it is not known. */
  hostBusyPercent: number | null;
  cpus: number;
  /** Processor use by everything Provelox knows (apps and platform services), in percent of ONE core, summed */
  knownPercentOfCores: number;
}

/** From this share of the machine busy, and with the share the known work explains below the other, it is flagged. */
export const BUSY_FROM = 40;
export const EXPLAINED_BELOW = 0.25;

export function unaccountedCpuFinding(c: CpuAccount): Finding | null {
  if (c.hostBusyPercent === null || c.cpus <= 0) return null;
  if (c.hostBusyPercent < BUSY_FROM) return null;
  const known = Math.min(100, c.knownPercentOfCores / c.cpus);
  if (known / c.hostBusyPercent >= EXPLAINED_BELOW) return null;
  return {
    id: 'cpu-unaccounted',
    severity: 'critical',
    title: 'The processor is busy with work no app accounts for',
    detail: `The machine's processor is ${Math.round(c.hostBusyPercent)}% busy, but every app and platform service together uses about ${Math.round(known)}%. Something Provelox does not run is using the rest. Cryptocurrency miners do exactly this, and some hide themselves from tools such as top and ps.`,
    fix: 'Look at the host findings below, and from a shell compare `top` with `cat /proc/stat` over a few seconds. If the machine cannot account for its own work, treat it as compromised: copy the data off, rebuild it from a clean image, and rotate every secret that was on it.',
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The host: what the read-only helper saw

export interface HostReport {
  preload?: {
    size: number;
    entries: { path: string; exists: boolean; size: number }[];
  } | null;
  uid0?: string[];
  cgroupOnly?: number;
  oddProcs?: { name: string; exe: string }[];
  oddProcCount?: number;
  /** The same, inside a container (`c` is the start of its id): a deleted program or one run from a temporary folder */
  oddCtrProcs?: { name: string; exe: string; c: string }[];
  oddCtrProcCount?: number;
  cron?: { file: string; line: string; known: boolean }[];
  elf?: string[];
  sshd?: { password: string | null; rootLogin: string | null };
  keys?: {
    ageDays: number | null;
    list: { type: string; fp: string; comment: string }[];
  } | null;
  auth?: { failed24h: number; top: [string, number][] } | null;
  dockerTcp?: boolean;
  hostBusy?: { name: string; cpu: number }[];
}

/** The last line of the helper's output that is JSON. */
export function parseHostReport(output: string): HostReport {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'));
  if (!line) throw new Error('The helper printed no reading.');
  return JSON.parse(line) as HostReport;
}

/** A week: a key file changed more recently than this is worth a look. */
const KEYS_CHANGED_DAYS = 7;
/** Hidden entries below this many are put down to processes that came and went while the helper looked. */
export const HIDDEN_FROM = 3;

const REBUILD =
  'Treat the machine as compromised: take a snapshot, copy the data off, rebuild it from a clean image, and rotate every secret that was on it. Removing the file alone does not remove what put it there.';

export function hostFindings(
  r: HostReport,
  containers: Record<string, string> = {},
): Finding[] {
  const out: Finding[] = [];

  if (r.preload && r.preload.entries.length > 0) {
    const named = r.preload.entries
      .map(
        (e) => `${e.path}${e.exists ? '' : ' (the file is hidden or missing)'}`,
      )
      .join(', ');
    out.push({
      id: 'ld-preload',
      severity: 'critical',
      title: '/etc/ld.so.preload loads a library into every program',
      detail: `This file does not exist on a normal server. It makes the system load ${named} into every program that starts, which is how a rootkit hides its files and processes from tools like ps and ls. A library can also be loaded this way to hide a cryptocurrency miner.`,
      fix: REBUILD,
    });
  }

  if (r.uid0 && r.uid0.length > 0)
    out.push({
      id: 'uid0-account',
      severity: 'critical',
      title: `Another account has root's user id: ${r.uid0.join(', ')}`,
      detail:
        'Only root should have user id 0. An account added with the same id is a back door with full control that does not show up as "root".',
      fix: REBUILD,
    });

  if ((r.cgroupOnly ?? 0) >= HIDDEN_FROM)
    out.push({
      id: 'hidden-processes',
      severity: 'critical',
      title: `${r.cgroupOnly} processes are in the kernel's lists but not in /proc`,
      detail:
        'The kernel counts these processes as running in a control group, yet they are not listed as processes. Something is hiding them.',
      fix: REBUILD,
    });

  if ((r.oddProcCount ?? 0) > 0) {
    const shown = (r.oddProcs ?? [])
      .map((p) => `${p.name || 'a process'} (${p.exe})`)
      .join(', ');
    out.push({
      id: 'odd-processes',
      severity: 'critical',
      title: `A process runs from a temporary or hidden place${(r.oddProcCount ?? 0) > 1 ? ` (${r.oddProcCount})` : ''}`,
      detail: `${shown}. Programs that are deleted while running, or that run from /tmp, /dev/shm or a folder starting with a dot, are how malware usually runs. Normal software does not.`,
      fix: REBUILD,
    });
  }

  if ((r.oddCtrProcCount ?? 0) > 0) {
    const shown = (r.oddCtrProcs ?? [])
      .map((p) => {
        const owner = containers[p.c];
        return `${p.name || 'a process'} in ${owner ? owner.replace(/^pvx-/, '') : `container ${p.c}`} (${p.exe})`;
      })
      .join(', ');
    out.push({
      id: 'odd-processes-in-container',
      severity: 'warning',
      title: `A program in a container runs from a temporary place or was deleted${(r.oddCtrProcCount ?? 0) > 1 ? ` (${r.oddCtrProcCount})` : ''}`,
      detail: `${shown}. Some tools unpack themselves to /tmp, but a program that runs from /tmp, /dev/shm or is deleted while running is also how malware runs inside an app.`,
      fix: 'Look at that app: what it runs and where it came from. If you do not recognise it, redeploy the app from a clean image and change its secrets.',
    });
  }

  for (const [i, c] of (r.cron ?? []).entries())
    out.push({
      id: `cron:${i}:${c.file}`,
      severity: c.known ? 'critical' : 'warning',
      title: c.known
        ? `A scheduled job matches known malware (${c.file})`
        : `A scheduled job runs something from a hidden or temporary place (${c.file})`,
      detail: c.known
        ? `${c.file}: ${c.line}. These names belong to cryptocurrency-mining malware.`
        : `${c.file}: ${c.line}. Jobs that run from /tmp, /dev/shm or a folder starting with a dot are how malware comes back after a restart. It may also be something you set up yourself.`,
      fix: c.known
        ? REBUILD
        : 'If you did not set this up, treat the machine as compromised.',
    });

  if ((r.elf ?? []).length > 0)
    out.push({
      id: 'elf-in-tmp',
      severity: 'warning',
      title: 'Programs are left in a temporary folder',
      detail: `${(r.elf ?? []).join(', ')} are executable programs in a place anyone can write to. Installers sometimes leave one; malware usually does.`,
      fix: 'If you do not recognise them, treat the machine as compromised.',
    });

  if (r.dockerTcp)
    out.push({
      id: 'docker-tcp',
      severity: 'critical',
      title: 'Docker accepts connections from the network without TLS',
      detail:
        'Docker is configured to listen on a network address with no certificate check. Anyone who can reach that port can start a container that mounts the whole machine, which is full control.',
      fix: 'Remove the tcp:// entry from "hosts" in /etc/docker/daemon.json (and any -H tcp:// in the service file) and restart Docker. Provelox needs only the local socket.',
    });

  const ssh = r.sshd;
  if (ssh && (ssh.password === 'yes' || ssh.rootLogin === 'yes'))
    out.push({
      id: 'ssh-password',
      severity: 'warning',
      title:
        ssh.password === 'yes' && ssh.rootLogin === 'yes'
          ? 'SSH accepts root logins with a password'
          : ssh.password === 'yes'
            ? 'SSH accepts passwords'
            : 'SSH accepts root logins with a password',
      detail:
        'Servers on the internet are guessed at all day by programs trying common passwords. A key cannot be guessed, a password can.',
      fix: 'In /etc/ssh/sshd_config set `PasswordAuthentication no` and `PermitRootLogin prohibit-password` (keep a session open while you test), then reload sshd.',
    });

  if (r.keys) {
    const n = r.keys.list.length;
    if (n > 0)
      out.push({
        id: 'ssh-keys',
        severity: 'info',
        title: `${n} ${n === 1 ? 'key may' : 'keys may'} sign in as root`,
        detail: r.keys.list
          .map((k) => `${k.fp} ${k.type}${k.comment ? ` (${k.comment})` : ''}`)
          .join('; '),
        fix: 'Compare these with your own keys (`ssh-keygen -lf ~/.ssh/id_ed25519.pub`). Remove any you do not recognise.',
      });
    if (r.keys.ageDays !== null && r.keys.ageDays < KEYS_CHANGED_DAYS)
      out.push({
        id: 'ssh-keys-changed',
        severity: 'warning',
        title: `The list of keys that may sign in as root changed ${r.keys.ageDays < 1 ? 'today' : `${Math.floor(r.keys.ageDays)} days ago`}`,
        detail:
          'If you did not change it, someone else did. Attackers add their own key to keep access.',
        fix: 'Check the keys listed above against your own.',
      });
  }

  if (r.auth && r.auth.failed24h > 0)
    out.push({
      id: 'ssh-failed',
      severity: 'info',
      title: `${r.auth.failed24h} failed sign-in attempts in the last day`,
      detail:
        r.auth.top.length > 0
          ? `Most from ${r.auth.top.map(([ip, n]) => `${ip} (${n})`).join(', ')}.`
          : 'Their addresses were not recorded.',
      fix: 'Normal for a server on the internet. It is only a risk where passwords are accepted.',
    });

  for (const [i, p] of (r.hostBusy ?? []).entries())
    out.push({
      id: `host-busy:${i}:${p.name}`,
      severity: 'warning',
      title: `${p.name} outside any container is using ${p.cpu}% of a core`,
      detail:
        'A process on the machine itself, not in an app, is working hard. It may be something you run; it may be a miner.',
      fix: 'Find out what it is (`ls -l /proc/<pid>/exe`).',
    });

  return out;
}
