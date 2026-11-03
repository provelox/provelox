import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppsService } from '../apps/apps.service';
import { loadConfig, type Config } from '../config/config';
import { DockerodeAdapter } from '../docker/dockerode.adapter';
import { ImportsService } from '../imports/imports.service';
import { DatabaseBackupService } from './database-backup.service';
import { DatabaseImportService } from './database-import.service';

/**
 * Against a real Docker daemon. Off unless DOCKER_INTEGRATION=1 (it pulls images and starts database servers). The import
 * folder is a temporary folder made here and removed at the end, never /var/lib/provelox. For each engine, one at a time:
 * saves a dump into the folder through the real helpers, lists it, restores it from the file into a second, empty
 * container, and compares the rows; also replace, a dump of another engine, a failed dump, and a link named like a dump.
 * Every container and file is removed after each engine.
 *
 * Which engines run: DB_FOLDER_IMAGES, a comma-separated list of images (default postgres:16 and mariadb:11).
 */
const run = process.env.DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' });
const tryDocker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8' });
const execFileAsync = promisify(execFile);
/** For calls made while a dump is being moved along: asynchronous, so this process keeps moving it, and time-limited */
const dockerAsync = (...args: string[]) =>
  execFileAsync('docker', args, { encoding: 'utf8', timeout: 30_000 });

interface Engine {
  image: string;
  engine: 'postgres' | 'mysql' | 'mariadb';
  env: string[];
  sql: (container: string, sql: string) => string;
  tool: string;
  /** SQL text of another engine, to be refused */
  foreign: string;
  /** What the saved file ends in */
  ending: RegExp;
}

const PW = 'pw-for-the-test-123';
const pg = (container: string, sql: string) =>
  docker(
    'exec',
    '-e',
    `PGPASSWORD=${PW}`,
    container,
    'psql',
    '-U',
    'app',
    '-d',
    'shop',
    '-tA',
    '-c',
    sql,
  ).trim();
const my = (bin: string) => (container: string, sql: string) =>
  docker(
    'exec',
    '-e',
    `MYSQL_PWD=${PW}`,
    container,
    bin,
    '-uroot',
    'shop',
    '-N',
    '-B',
    '-e',
    sql,
  ).trim();

const ALL: Engine[] = [
  {
    image: 'postgres:16',
    engine: 'postgres',
    env: ['POSTGRES_USER=app', 'POSTGRES_DB=shop', `POSTGRES_PASSWORD=${PW}`],
    sql: pg,
    tool: 'pg_dump',
    foreign: '-- MySQL dump 10.13\nCREATE TABLE t (id int);\n',
    ending: /\.dump$/,
  },
  {
    image: 'postgres:9.6',
    engine: 'postgres',
    env: ['POSTGRES_USER=app', 'POSTGRES_DB=shop', `POSTGRES_PASSWORD=${PW}`],
    sql: pg,
    tool: 'pg_dump',
    foreign: '-- MariaDB dump 10.19\nCREATE TABLE t (id int);\n',
    ending: /\.dump$/,
  },
  {
    image: 'mariadb:11',
    engine: 'mariadb',
    env: [`MARIADB_ROOT_PASSWORD=${PW}`, 'MARIADB_DATABASE=shop'],
    sql: my('mariadb'),
    tool: 'mariadb-dump',
    foreign: '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n',
    ending: /\.sql\.gz$/,
  },
  {
    image: 'mysql:8.4',
    engine: 'mysql',
    env: [`MYSQL_ROOT_PASSWORD=${PW}`, 'MYSQL_DATABASE=shop'],
    sql: my('mysql'),
    tool: 'mysqldump',
    foreign: '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n',
    ending: /\.sql\.gz$/,
  },
];
const WANTED = (process.env.DB_FOLDER_IMAGES ?? 'postgres:16,mariadb:11')
  .split(',')
  .map((s) => s.trim());
const ENGINES = ALL.filter((e) => WANTED.includes(e.image));

const PID = process.pid;

async function ready(e: Engine, c: string) {
  // The images restart their server once after initialising: wait until it answers several times in a row
  let ok = 0;
  for (let i = 0; i < 90 && ok < 3; i++) {
    const r = tryDocker(
      'exec',
      ...(e.engine === 'postgres'
        ? ['-e', `PGPASSWORD=${PW}`]
        : ['-e', `MYSQL_PWD=${PW}`]),
      c,
      ...(e.engine === 'postgres'
        ? ['psql', '-U', 'app', '-d', 'shop', '-tAc', 'select 1']
        : [
            e.engine === 'mariadb' ? 'mariadb' : 'mysql',
            '-uroot',
            'shop',
            '-N',
            '-e',
            'select 1',
          ]),
    );
    ok = r.status === 0 && r.stdout.trim() === '1' ? ok + 1 : 0;
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (ok < 3)
    throw new Error(
      `${e.image} did not become ready:\n${tryDocker('logs', '--tail', '20', c).stderr}`,
    );
}

run('database dumps through the import folder (real Docker)', () => {
  let folder = '';
  let cfg: Config;
  let adapter: DockerodeAdapter;

  beforeAll(() => {
    // realpath: on macOS the temporary folder is a link, and Docker needs the real path to share it
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'pvx-dbfolder-')));
    chmodSync(folder, 0o755);
    cfg = loadConfig({
      JWT_SECRET: 'x'.repeat(40),
      ROOT_DOMAIN: 'example.com',
      ACME_EMAIL: 'ops@example.com',
      DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
      IMPORTS_DIR: folder,
    });
    adapter = new DockerodeAdapter(cfg);
  });
  afterAll(() => {
    // the helpers run as root and may have made root-owned files: remove through Docker, then the folder itself
    tryDocker(
      'run',
      '--rm',
      '-v',
      `${folder}:/x`,
      cfg?.HELPER_IMAGE ?? 'busybox:latest',
      'sh',
      '-c',
      'rm -rf /x/* /x/.[!.]* 2>/dev/null; true',
    );
    rmSync(folder, { recursive: true, force: true });
  });

  describe.each(ENGINES)('$image', (e) => {
    const slug = e.image.replace(/[^a-z0-9]/g, '');
    const a = `pvx-dbit-${PID}-${slug}-a`;
    const b = `pvx-dbit-${PID}-${slug}-b`;
    let current = a;
    let imports: ImportsService;
    let svc: DatabaseImportService;
    let saved = '';
    const totalSql = 'select count(*), sum(id), max(v) from t';
    const here = () => readdirSync(folder).sort();

    beforeAll(async () => {
      const apps = {
        getDefinition: (name: string) => ({
          name,
          image: e.image,
          instanceCount: 1,
        }),
        heldTo: () => null,
      } as unknown as AppsService;
      // These containers are not Swarm services: the container to use is the one the test says
      adapter.serviceContainer = async () => current;
      adapter.localNodeId = async () => null;
      imports = new ImportsService(adapter, cfg);
      svc = new DatabaseImportService(
        new DatabaseBackupService(apps, adapter),
        imports,
      );
      for (const name of [a, b])
        docker(
          'run',
          '-d',
          '--name',
          name,
          ...e.env.flatMap((v) => ['-e', v]),
          e.image,
        );
      await Promise.all([ready(e, a), ready(e, b)]);
      e.sql(
        a,
        e.engine === 'postgres'
          ? "create table t (id int primary key, v text); insert into t select g, 'héllo wörld ✓ ' || g from generate_series(1, 200) g"
          : "create table t (id int primary key, v text) character set utf8mb4; insert into t with recursive s(g) as (select 1 union all select g + 1 from s where g < 200) select g, concat('héllo wörld ✓ ', g) from s",
      );
    }, 300_000);

    afterAll(() => {
      for (const c of [a, b]) tryDocker('rm', '-f', '-v', c);
      // one engine at a time: leave nothing of it behind
      for (const f of readdirSync(folder))
        tryDocker(
          'run',
          '--rm',
          '-v',
          `${folder}:/x`,
          cfg.HELPER_IMAGE,
          'rm',
          '-rf',
          `/x/${f}`,
        );
    });

    it('saves a dump into the folder, and it is listed as a database file with nothing half-written beside it', async () => {
      current = a;
      const r = await svc.exportDump('db');
      saved = r.file;
      expect(r.file).toMatch(e.ending);
      expect(r.dir).toBe(folder);
      expect(r.sizeBytes).toBeGreaterThan(500);
      // on disk: the file, and no hidden part file
      expect(here()).toEqual([saved]);
      const l = await imports.list();
      expect(l.files.map((f) => [f.name, f.kind, f.sizeBytes])).toEqual([
        [saved, 'database', r.sizeBytes],
      ]);
    }, 180_000);

    it('restores from that file into an empty server of the same image, and the rows are the same', async () => {
      current = b;
      const r = await svc.restoreFrom('db', saved);
      expect(r).toMatchObject({ restored: true, file: saved });
      expect(e.sql(b, totalSql)).toBe(e.sql(a, totalSql));
      expect(e.sql(b, 'select v from t where id = 7')).toBe('héllo wörld ✓ 7');
    }, 180_000);

    it('replaces what is there only with the app name, and the file stays in the folder', async () => {
      current = b;
      e.sql(b, "insert into t values (9001, 'extra')");
      e.sql(b, 'create table only_here (id int)');
      await expect(
        svc.restoreFrom('db', saved, { clean: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(e.sql(b, 'select count(*) from t')).toBe('201');
      await svc.restoreFrom('db', saved, { clean: true, confirm: 'db' });
      expect(e.sql(b, 'select count(*) from t')).toBe('200');
      expect(
        e.sql(
          b,
          `select count(*) from information_schema.tables where table_name = 'only_here' and table_schema = ${e.engine === 'postgres' ? "'public'" : "'shop'"}`,
        ),
      ).toBe('0');
      expect(e.sql(b, totalSql)).toBe(e.sql(a, totalSql));
      expect(here()).toContain(saved);
    }, 240_000);

    it('refuses a dump of another engine from the folder, with the database untouched', async () => {
      current = b;
      writeFileSync(join(folder, 'foreign.sql'), e.foreign);
      await expect(svc.restoreFrom('db', 'foreign.sql')).rejects.toMatchObject({
        status: 400,
      });
      expect(e.sql(b, 'select count(*) from t')).toBe('200');
    }, 120_000);

    it('a volume archive in the folder is never fed to the database, and a link named like a dump is not a file', async () => {
      current = b;
      writeFileSync(join(folder, 'volume.tar.gz'), 'x');
      await expect(
        svc.restoreFrom('db', 'volume.tar.gz'),
      ).rejects.toMatchObject({ status: 400 });
      // a link to a real file, named like a dump: not listed, not found
      symlinkSync(join(folder, saved), join(folder, 'link.dump'));
      const l = await imports.list();
      expect(l.files.map((f) => f.name)).not.toContain('link.dump');
      await expect(svc.restoreFrom('db', 'link.dump')).rejects.toMatchObject({
        status: 404,
      });
      expect(e.sql(b, 'select count(*) from t')).toBe('200');
    }, 120_000);

    it('a dump killed inside the container leaves no file and no part file', async () => {
      current = a;
      const before = here();
      // enough rows that the dump is still running when it is killed
      e.sql(
        a,
        e.engine === 'postgres'
          ? 'create table big as select (a.id*1000000+b.id*1000+c.id) as id, md5((a.id*1000000+b.id*1000+c.id)::text) || md5(b.id::text) || md5(c.id::text) as v from t a, t b, t c where c.id <= 10'
          : 'create table big (id bigint, v varchar(100)) engine=innodb; insert into big select a.id*1000000+b.id*1000+c.id, concat(md5(a.id*1000000+b.id*1000+c.id), md5(b.id), md5(c.id)) from t a, t b, t c where c.id <= 10',
      );
      const failing = svc.exportDump(
        'db',
        {},
        new Date('2030-01-01T00:00:00Z'),
      );
      // wait until the dump is running, then kill the tool from outside, as a crash would. These calls are asynchronous
      // (and have a time limit): a synchronous one would stop this process from moving the dump along, and a stuck
      // `docker exec` would then stop everything.
      for (let i = 0; i < 60; i++) {
        const { stdout } = await dockerAsync(
          'exec',
          a,
          'sh',
          '-c',
          `for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = "${e.tool.slice(0, 15)}" ] && echo \${p#/proc/}; done; true`,
        );
        if (stdout.trim()) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await dockerAsync(
        'exec',
        a,
        'sh',
        '-c',
        `for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = "${e.tool.slice(0, 15)}" ] && kill -9 \${p#/proc/}; done; true`,
      );
      await expect(failing).rejects.toThrow(
        /did not finish|stopped|wrote nothing/,
      );
      // nothing new in the folder, hidden or not
      expect(here()).toEqual(before);
      expect(
        existsSync(
          join(
            folder,
            `db-20300101-000000${e.ending.source.includes('dump') ? '.dump' : '.sql.gz'}`,
          ),
        ),
      ).toBe(false);
    }, 300_000);
  });
});
