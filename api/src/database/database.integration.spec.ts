import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AppsService } from '../apps/apps.service';
import { loadConfig } from '../config/config';
import { DockerodeAdapter } from '../docker/dockerode.adapter';
import { DatabaseBackupService } from './database-backup.service';

/**
 * Against a real Docker daemon. Off unless DOCKER_INTEGRATION=1 (it pulls images and starts database servers), so the
 * normal test run never needs Docker. Starts throwaway containers, dumps one through the real exec path, restores into
 * a second, empty one of the same image, and compares the rows. Every container and file is removed at the end.
 */
const run = process.env.DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' });
const tryDocker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8' });

interface Engine {
  image: string;
  /** What `info` must answer */
  engine: 'postgres' | 'mysql' | 'mariadb';
  /** Settings the image is started with; the password comes from a file (the *_FILE variant) or the plain variable */
  env: (passwordFile: string) => string[];
  withFile: boolean;
  /** Runs SQL in a container and returns what it printed */
  sql: (container: string, sql: string) => string;
  /** The name of the dump tool, to look for it running */
  tool: string;
  /** SQL text of another engine, to be refused */
  foreign: string;
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

const ENGINES: Engine[] = [
  {
    image: 'postgres:16',
    engine: 'postgres',
    env: (f) => [
      'POSTGRES_USER=app',
      'POSTGRES_DB=shop',
      `POSTGRES_PASSWORD_FILE=${f}`,
    ],
    withFile: true,
    sql: pg,
    tool: 'pg_dump',
    foreign: '-- MySQL dump 10.13\nCREATE TABLE t (id int);\n',
  },
  {
    image: 'postgres:9.6',
    engine: 'postgres',
    env: () => [
      'POSTGRES_USER=app',
      'POSTGRES_DB=shop',
      `POSTGRES_PASSWORD=${PW}`,
    ],
    withFile: false,
    sql: pg,
    tool: 'pg_dump',
    foreign: '-- MariaDB dump 10.19\nCREATE TABLE t (id int);\n',
  },
  {
    image: 'mariadb:11',
    engine: 'mariadb',
    env: () => [`MARIADB_ROOT_PASSWORD=${PW}`, 'MARIADB_DATABASE=shop'],
    withFile: false,
    sql: my('mariadb'),
    tool: 'mariadb-dump',
    foreign: '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n',
  },
  {
    image: 'mysql:8.4',
    engine: 'mysql',
    env: (f) => [`MYSQL_ROOT_PASSWORD_FILE=${f}`, 'MYSQL_DATABASE=shop'],
    withFile: true,
    sql: my('mysql'),
    tool: 'mysqldump',
    foreign: '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n',
  },
];

const PID = process.pid;
const dir = mkdtempSync(join(tmpdir(), 'pvx-dbit-'));
const pwFile = join(dir, 'pw');
const started: string[] = [];

/** A service wired to the real Docker, for apps that are plain containers: the app lookup is the only stand-in */
function serviceFor(
  adapter: DockerodeAdapter,
  image: string,
  current: () => string,
) {
  const apps = {
    getDefinition: (name: string) => ({ name, image, instanceCount: 1 }),
    heldTo: () => null,
  } as unknown as AppsService;
  // These containers are not Swarm services: the container to use is the one the test says
  adapter.serviceContainer = async () => current();
  adapter.localNodeId = async () => null;
  return new DatabaseBackupService(apps, adapter);
}

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

function start(e: Engine, name: string) {
  const args = ['run', '-d', '--name', name];
  for (const v of e.env('/run/pw')) args.push('-e', v);
  if (e.withFile) args.push('-v', `${pwFile}:/run/pw:ro`);
  args.push(e.image);
  docker(...args);
  started.push(name);
}

const read = async (s: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
};

run('database dump and restore (real Docker)', () => {
  const adapter = new DockerodeAdapter(
    loadConfig({
      JWT_SECRET: 'x'.repeat(40),
      ROOT_DOMAIN: 'example.com',
      ACME_EMAIL: 'ops@example.com',
      DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    }),
  );

  beforeAll(() => {
    writeFileSync(pwFile, `${PW}\n`);
    chmodSync(pwFile, 0o644);
  });
  afterAll(() => {
    for (const c of started) tryDocker('rm', '-f', '-v', c);
    rmSync(dir, { recursive: true, force: true });
  });

  describe.each(ENGINES)('$image', (e) => {
    const a = `pvx-dbit-${PID}-${e.image.replace(/[^a-z0-9]/g, '')}-a`;
    const b = `pvx-dbit-${PID}-${e.image.replace(/[^a-z0-9]/g, '')}-b`;
    let current = a;
    let svc: DatabaseBackupService;
    let dump: Buffer;
    const totalSql = 'select count(*), sum(id), max(v) from t';

    beforeAll(async () => {
      svc = serviceFor(adapter, e.image, () => current);
      start(e, a);
      start(e, b);
      await Promise.all([ready(e, a), ready(e, b)]);
      e.sql(
        a,
        e.engine === 'postgres'
          ? "create table t (id int primary key, v text); insert into t select g, 'héllo wörld ✓ ' || g from generate_series(1, 200) g"
          : "create table t (id int primary key, v text) character set utf8mb4; insert into t with recursive s(g) as (select 1 union all select g + 1 from s where g < 200) select g, concat('héllo wörld ✓ ', g) from s",
      );
    }, 300_000);

    it('detects the engine from the image and the tools in the container', async () => {
      current = a;
      expect(await svc.info('db')).toEqual({
        engine: e.engine,
        canBackup: true,
      });
    }, 60_000);

    it('dumps through the exec path, and the dump is complete', async () => {
      current = a;
      const d = await svc.dump('db');
      dump = await read(d.stream);
      const r = await d.finished;
      expect(r).toEqual({ ok: true, detail: '' });
      expect(dump.length).toBeGreaterThan(500);
      expect(d.filename).toMatch(
        e.engine === 'postgres' ? /\.dump$/ : /\.sql\.gz$/,
      );
    }, 120_000);

    it('restores into an empty server of the same image, and the rows are the same', async () => {
      current = b;
      const r = await svc.restore('db', Readable.from([dump]));
      expect(r.restored).toBe(true);
      expect(r.bytes).toBe(dump.length);
      expect(e.sql(b, totalSql)).toBe(e.sql(a, totalSql));
      expect(e.sql(b, 'select v from t where id = 7')).toBe('héllo wörld ✓ 7');
    }, 120_000);

    it('adds to what is there, and replaces it only when asked', async () => {
      current = b;
      const tableHere = (name: string) =>
        e.sql(
          b,
          `select count(*) from information_schema.tables where table_name = '${name}' and table_schema = ${e.engine === 'postgres' ? "'public'" : "'shop'"}`,
        );
      e.sql(b, "insert into t values (9001, 'extra')");
      e.sql(b, 'create table only_here (id int)');
      expect(e.sql(b, 'select count(*) from t')).toBe('201');
      if (e.engine === 'postgres') {
        // the tables are already there, so it stops at the first error and says so
        await expect(
          svc.restore('db', Readable.from([dump])),
        ).rejects.toMatchObject({
          status: 422,
        });
        expect(e.sql(b, 'select count(*) from t')).toBe('201');
      } else {
        // mysqldump drops each table it recreates, so the tables of the dump are replaced; others are left alone
        await svc.restore('db', Readable.from([dump]));
        expect(e.sql(b, 'select count(*) from t')).toBe('200');
        expect(tableHere('only_here')).toBe('1');
        e.sql(b, "insert into t values (9001, 'extra')");
      }
      // replaced: the extra row and the table the dump does not have are gone, and the data is the dump's
      await svc.restore('db', Readable.from([dump]), {
        clean: true,
        confirm: 'db',
      });
      expect(e.sql(b, 'select count(*) from t')).toBe('200');
      expect(tableHere('only_here')).toBe('0');
      expect(e.sql(b, totalSql)).toBe(e.sql(a, totalSql));
    }, 180_000);

    it('refuses a dump of another engine without touching the database', async () => {
      current = b;
      await expect(
        svc.restore('db', Readable.from([Buffer.from(e.foreign)])),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(e.sql(b, 'select count(*) from t')).toBe('200');
    }, 60_000);

    it('a dump killed inside the container is a failure, not a complete file', async () => {
      current = a;
      // enough rows that the dump is still running when it is killed; the reader is held back, so the tool waits on it
      e.sql(
        a,
        e.engine === 'postgres'
          ? 'create table big as select (a.id*1000000+b.id*1000+c.id) as id, md5((a.id*1000000+b.id*1000+c.id)::text) || md5(b.id::text) || md5(c.id::text) as v from t a, t b, t c where c.id <= 10'
          : 'create table big (id bigint, v varchar(100)) engine=innodb; insert into big select a.id*1000000+b.id*1000+c.id, concat(md5(a.id*1000000+b.id*1000+c.id), md5(b.id), md5(c.id)) from t a, t b, t c where c.id <= 10',
      );
      const d = await svc.dump('db');
      // read a little, then kill the tool from outside, as a crash would
      await new Promise<void>((resolve) =>
        d.stream.once('data', () => {
          d.stream.pause();
          resolve();
        }),
      );
      docker(
        'exec',
        a,
        'sh',
        '-c',
        `for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = "${e.tool.slice(0, 15)}" ] && kill -9 \${p#/proc/}; done; true`,
      );
      d.stream.resume();
      const r = await d.finished;
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/exit code/);
    }, 300_000);

    it('aborting a dump stops the tool inside the container', async () => {
      current = a;
      const d = await svc.dump('db');
      await new Promise<void>((resolve) =>
        d.stream.once('data', () => {
          d.stream.pause();
          resolve();
        }),
      );
      await d.abort();
      // nothing of the tool is left running in the container a moment later
      let left = '1';
      for (let i = 0; i < 20 && left !== ''; i++) {
        await new Promise((r) => setTimeout(r, 500));
        left = docker(
          'exec',
          a,
          'sh',
          '-c',
          `for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = "${e.tool.slice(0, 15)}" ] && echo \${p#/proc/}; done; true`,
        ).trim();
      }
      expect(left).toBe('');
    }, 300_000);
  });
});
