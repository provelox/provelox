import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXEC_KILL_SCRIPT } from '../docker/exec-kill';
import {
  MYSQL_MODES,
  MYSQL_SCRIPT,
  POSTGRES_MODES,
  POSTGRES_SCRIPT,
  PROBE_SCRIPT,
} from './scripts';

const syntax = (script: string) =>
  spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });

describe('the scripts run inside the container', () => {
  it.each([
    ['postgres', POSTGRES_SCRIPT],
    ['mysql', MYSQL_SCRIPT],
    ['probe', PROBE_SCRIPT],
    ['kill', EXEC_KILL_SCRIPT],
  ])('%s parses as shell', (_n, script) => {
    const r = syntax(script);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('are fixed text: no placeholder, nothing for a setting or a person to fill in', () => {
    for (const s of [POSTGRES_SCRIPT, MYSQL_SCRIPT, PROBE_SCRIPT]) {
      expect(s).not.toMatch(/\$\{\{|%s.*%s.*%s/);
      // nothing in them is a TypeScript leftover
      expect(s).not.toContain('undefined');
      expect(s).not.toContain('[object');
    }
  });

  it('read the *_FILE variants as well as the plain settings', () => {
    expect(POSTGRES_SCRIPT).toContain('printenv "$1_FILE"');
    for (const v of ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD'])
      expect(POSTGRES_SCRIPT).toContain(`val ${v}`);
    for (const v of [
      'MYSQL_ROOT_PASSWORD',
      'MARIADB_ROOT_PASSWORD',
      'MYSQL_USER',
      'MYSQL_PASSWORD',
      'MYSQL_DATABASE',
      'MARIADB_DATABASE',
    ])
      expect(MYSQL_SCRIPT).toContain(`val ${v}`);
  });

  it('never put a password on a command line', () => {
    // the only places a secret goes are environment variables
    expect(POSTGRES_SCRIPT).not.toMatch(/--password|-p"?\$P|-W/);
    expect(MYSQL_SCRIPT).not.toMatch(/--password|-p"?\$|-p\$/);
    expect(POSTGRES_SCRIPT).toContain('PGPASSWORD');
    expect(MYSQL_SCRIPT).toContain('export MYSQL_PWD');
  });

  it('refuse a mode they do not know', () => {
    for (const script of [POSTGRES_SCRIPT, MYSQL_SCRIPT]) {
      const r = spawnSync('sh', ['-c', script, 'sh', 'rm -rf /'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect(r.status).toBe(64);
      expect(r.stderr).toContain('unknown mode');
    }
  });

  it('have a mode for every restore and dump the service asks for', () => {
    for (const m of POSTGRES_MODES) expect(POSTGRES_SCRIPT).toContain(`${m})`);
    for (const m of MYSQL_MODES) expect(MYSQL_SCRIPT).toContain(`${m})`);
  });
});

/**
 * The system's own programs (cat, printenv, sh and the rest) without any database client the machine happens to have: a
 * CI runner has real mysql and PostgreSQL tools in /usr/bin, a laptop usually has none. A test must see only the
 * stand-ins it makes.
 */
function systemProgramsWithoutDatabaseClients(into: string) {
  mkdirSync(into);
  const seen = new Set<string>();
  for (const d of ['/usr/bin', '/bin']) {
    for (const name of readdirSync(d)) {
      if (/^(mysql|mariadb|pg_|psql)/.test(name) || seen.has(name)) continue;
      seen.add(name);
      try {
        symlinkSync(join(d, name), join(into, name));
      } catch {
        // a name that cannot be linked is one the scripts do not need
      }
    }
  }
  return into;
}

/** Runs the real script with stand-in programs that print how they were called and what the environment held */
describe('the scripts, run against stand-in tools', () => {
  let dir: string;
  let bin: string;
  let sys: string;
  let sysRoot: string;
  beforeAll(() => {
    sysRoot = mkdtempSync(join(tmpdir(), 'pvx-sys-'));
    sys = systemProgramsWithoutDatabaseClients(join(sysRoot, 'bin'));
  });
  afterAll(() => rmSync(sysRoot, { recursive: true, force: true }));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pvx-db-'));
    bin = join(dir, 'bin');
    mkdirSync(bin);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A program that writes its name, its arguments and the settings it was given to a file, and reads stdin to another */
  const tool = (name: string) => {
    const f = join(bin, name);
    writeFileSync(
      f,
      `#!/bin/sh
{ echo "ARGS:$*"; echo "PGPASSWORD=\${PGPASSWORD:-}"; echo "MYSQL_PWD=\${MYSQL_PWD:-}"; } >> "${dir}/${name}.calls"
cat > "${dir}/${name}.stdin"
`,
    );
    chmodSync(f, 0o755);
  };
  const run = (
    script: string,
    mode: string,
    env: Record<string, string>,
    input = '',
  ) =>
    spawnSync('sh', ['-c', script, 'sh', mode], {
      encoding: 'utf8',
      input,
      env: { PATH: `${bin}:${sys}`, ...env },
    });
  const calls = (name: string) =>
    readFileSync(join(dir, `${name}.calls`), 'utf8');

  it('PostgreSQL: user, database and password from the environment', () => {
    tool('pg_dump');
    const r = run(POSTGRES_SCRIPT, 'dump-custom', {
      POSTGRES_USER: 'app',
      POSTGRES_DB: 'shop',
      POSTGRES_PASSWORD: 's3cret',
    });
    expect(r.status).toBe(0);
    const c = calls('pg_dump');
    expect(c).toContain('ARGS:-U app -d shop -Fc');
    expect(c).toContain('PGPASSWORD=s3cret');
    // the password is in the environment and nowhere in the arguments
    expect(c.split('\n')[0]).not.toContain('s3cret');
  });

  it('PostgreSQL: the password and user from *_FILE, the way the official image takes secrets', () => {
    tool('pg_dump');
    writeFileSync(join(dir, 'pw'), 'from-a-file\n');
    writeFileSync(join(dir, 'user'), 'fileuser');
    run(POSTGRES_SCRIPT, 'dump-custom', {
      POSTGRES_USER_FILE: join(dir, 'user'),
      POSTGRES_PASSWORD_FILE: join(dir, 'pw'),
    });
    const c = calls('pg_dump');
    expect(c).toContain('ARGS:-U fileuser -d fileuser -Fc');
    expect(c).toContain('PGPASSWORD=from-a-file');
  });

  it('PostgreSQL: postgres and its own name by default, no password variable when there is none', () => {
    tool('pg_dumpall');
    run(POSTGRES_SCRIPT, 'dump-all', {});
    const c = calls('pg_dumpall');
    expect(c).toContain('ARGS:-U postgres');
    expect(c).toContain('PGPASSWORD=\n');
  });

  it('PostgreSQL restore: stops at the first error, and takes what it is sent on its input', () => {
    tool('pg_restore');
    tool('psql');
    const r = run(
      POSTGRES_SCRIPT,
      'restore-custom-clean',
      { POSTGRES_USER: 'u', POSTGRES_DB: 'd' },
      'PGDMP...',
    );
    expect(r.status).toBe(0);
    expect(calls('pg_restore')).toContain(
      'ARGS:-U u -d d --no-owner --no-acl --exit-on-error --clean --if-exists',
    );
    expect(readFileSync(join(dir, 'pg_restore.stdin'), 'utf8')).toBe(
      'PGDMP...',
    );
    tool('psql');
    run(POSTGRES_SCRIPT, 'restore-sql', { POSTGRES_USER: 'u' }, 'select 1;');
    expect(calls('psql')).toContain('-v ON_ERROR_STOP=1 -f -');
  });

  it('PostgreSQL replace drops every schema of the database first, then restores', () => {
    tool('psql');
    run(POSTGRES_SCRIPT, 'restore-sql-clean', { POSTGRES_USER: 'u' }, 'x');
    const c = calls('psql').split('ARGS:').filter(Boolean);
    expect(c).toHaveLength(2);
    expect(c[0]).toContain('DROP SCHEMA %I CASCADE');
    expect(c[0]).toContain('CREATE SCHEMA public');
    // the server's own schemas are left alone
    expect(c[0]).toContain("NOT LIKE 'pg\\_%'");
    expect(c[0]).toContain("<> 'information_schema'");
    expect(c[1]).toContain('-f -');
  });

  it('MySQL: the password goes in MYSQL_PWD, root by default, never in the arguments', () => {
    tool('mysqldump');
    run(MYSQL_SCRIPT, 'dump', {
      MYSQL_ROOT_PASSWORD: 'rootpw',
      MYSQL_DATABASE: 'shop',
    });
    const c = calls('mysqldump');
    expect(c).toContain(
      'ARGS:-uroot --single-transaction --routines --triggers --events shop',
    );
    expect(c).toContain('MYSQL_PWD=rootpw');
    expect(c.split('\n')[0]).not.toContain('rootpw');
  });

  it("MySQL: the app's own user when there is no root password to use", () => {
    tool('mysqldump');
    writeFileSync(join(dir, 'upw'), 'userpw\n');
    run(MYSQL_SCRIPT, 'dump', {
      MYSQL_USER: 'app',
      MYSQL_PASSWORD_FILE: join(dir, 'upw'),
      MYSQL_DATABASE: 'shop',
    });
    const c = calls('mysqldump');
    expect(c).toContain('ARGS:-uapp');
    expect(c).toContain('MYSQL_PWD=userpw');
  });

  it('MariaDB 11: the new tool names when the old ones are not there', () => {
    tool('mariadb-dump');
    tool('mariadb');
    run(MYSQL_SCRIPT, 'dump-all', { MARIADB_ROOT_PASSWORD: 'mp' });
    expect(calls('mariadb-dump')).toContain('--all-databases');
    run(
      MYSQL_SCRIPT,
      'restore-all',
      { MARIADB_ROOT_PASSWORD: 'mp' },
      'select 1;',
    );
    expect(calls('mariadb')).toContain('ARGS:-uroot');
  });

  it('MySQL replace: drops and creates the database named by the container, and refuses an odd name', () => {
    tool('mysql');
    run(MYSQL_SCRIPT, 'restore-clean', { MYSQL_DATABASE: 'shop' }, 'x');
    const c = calls('mysql').split('ARGS:').filter(Boolean);
    expect(c).toHaveLength(2);
    expect(readFileSync(join(dir, 'mysql.stdin'), 'utf8')).toBe('x');
    const odd = run(
      MYSQL_SCRIPT,
      'restore-clean',
      { MYSQL_DATABASE: 'a`; drop' },
      'x',
    );
    expect(odd.status).toBe(65);
  });

  it('the probe prints the tools that exist and nothing else', () => {
    tool('pg_dump');
    tool('psql');
    const out = execFileSync('sh', ['-c', PROBE_SCRIPT], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${sys}` },
    });
    expect(out.split('\n').filter(Boolean).sort()).toEqual(['pg_dump', 'psql']);
  });
});
