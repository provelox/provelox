import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DomainError, ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';
import { DatabaseBackupService } from './database-backup.service';
import { PROBE_SCRIPT } from './scripts';

const PG_TOOLS = 'pg_dump\npg_dumpall\npg_restore\npsql\n';
const MY_TOOLS = 'mysqldump\nmysql\n';
const PGDMP = Buffer.from('PGDMP\u0001\u000e\u0000dump-body-bytes');

async function setup(image = 'postgres:16', tools = PG_TOOLS) {
  const s = makeStack();
  await s.apps.create({ name: 'db' });
  await s.apps.update('db', {
    env: [
      { key: 'POSTGRES_PASSWORD', value: 'hunter2-the-secret' },
      { key: 'POSTGRES_USER', value: 'app' },
    ],
  });
  await s.apps.deploy('db', image);
  s.docker.containerIds.set('pvx-db', 'container-1');
  // the probe answers with the tools; anything else is the dump, or the restore's input
  s.docker.execScript = (spec) =>
    spec.cmd[2] === PROBE_SCRIPT ? { out: Buffer.from(tools) } : undefined;
  const svc = new DatabaseBackupService(s.apps, s.docker);
  return { ...s, svc };
}

const body = (b: Buffer | string) => Readable.from([Buffer.from(b)]);
const lastMode = (s: Awaited<ReturnType<typeof setup>>) =>
  s.docker.execRuns.at(-1)?.cmd[4];

async function read(stream: Readable) {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

describe('DatabaseBackupService.info', () => {
  it('names the engine when the image says so and the container has the tools', async () => {
    const s = await setup();
    expect(await s.svc.info('db')).toEqual({
      engine: 'postgres',
      canBackup: true,
    });
  });

  it('says nothing for an app that is not a database, and does not run anything in it', async () => {
    const s = await setup('nginx:1.27');
    expect(await s.svc.info('db')).toEqual({ engine: null, canBackup: false });
    expect(s.docker.execRuns).toHaveLength(0);
  });

  it('an image named like a database without the tools cannot be backed up, with the reason', async () => {
    const s = await setup('acme/custom-postgres:1', '');
    const i = await s.svc.info('db');
    expect(i.canBackup).toBe(false);
    expect(i.engine).toBe('postgres');
    expect(i.reason).toMatch(/pg_dump/);
  });

  it('settles a generic name by the tools it finds, as with img-captain-database', async () => {
    const s = await setup('ghcr.io/acme/img-captain-database:3', MY_TOOLS);
    expect(await s.svc.info('db')).toEqual({
      engine: 'mysql',
      canBackup: true,
    });
  });

  it('refuses an app that is stopped, and one with no container on this machine', async () => {
    const s = await setup();
    s.docker.containerIds.clear();
    await expect(s.svc.info('db')).rejects.toThrow(/Start the app first/);
    await s.apps.update('db', { instanceCount: 0 });
    await expect(s.svc.info('db')).rejects.toThrow(/not running/);
  });
});

describe('DatabaseBackupService.dump', () => {
  it('PostgreSQL gives the custom format as it comes, and says the file is complete only after the tool exited', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(PG_TOOLS) }
        : { out: PGDMP };
    const d = await s.svc.dump('db', {}, new Date('2026-11-02T01:02:03Z'));
    expect(d.filename).toBe('db-20261102-010203.dump');
    expect(d.contentType).toBe('application/octet-stream');
    const got = await read(d.stream);
    expect(got.equals(PGDMP)).toBe(true);
    expect(await d.finished).toEqual({ ok: true, detail: '' });
    expect(lastMode(s)).toBe('dump-custom');
  });

  it('everything else is SQL, gzipped here', async () => {
    const s = await setup('mysql:8', MY_TOOLS);
    const sql = '-- MySQL dump 10.13\nCREATE TABLE t (id int);\n';
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(MY_TOOLS) }
        : { out: Buffer.from(sql) };
    const d = await s.svc.dump('db', {}, new Date('2026-11-02T01:02:03Z'));
    expect(d.filename).toBe('db-20261102-010203.sql.gz');
    expect(d.contentType).toBe('application/gzip');
    expect(gunzipSync(await read(d.stream)).toString()).toBe(sql);
    expect((await d.finished).ok).toBe(true);
    expect(lastMode(s)).toBe('dump');
  });

  it('?all asks for every database, as SQL for PostgreSQL too', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(PG_TOOLS) }
        : { out: Buffer.from('-- PostgreSQL database cluster dump\n') };
    const d = await s.svc.dump('db', { all: true });
    expect(d.filename).toMatch(/\.sql\.gz$/);
    await read(d.stream);
    expect(lastMode(s)).toBe('dump-all');
  });

  it('a tool that dies half way makes a dump that is not ok, with why', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(PG_TOOLS) }
        : { out: PGDMP, exit: 1, stderr: 'pg_dump: error: connection lost' };
    const d = await s.svc.dump('db');
    await read(d.stream);
    const r = await d.finished;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('connection lost');
  });

  it('a tool that writes nothing is an error with its message, not an empty download', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(PG_TOOLS) }
        : {
            out: Buffer.alloc(0),
            exit: 1,
            stderr: 'pg_dump: error: database "x" does not exist',
          };
    await expect(s.svc.dump('db')).rejects.toThrow(/does not exist/);
  });

  it('the reader going away stops the tool', async () => {
    const s = await setup();
    s.docker.execHold = true;
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(PG_TOOLS) }
        : { out: PGDMP };
    // the probe must not hold: only the dump does
    const hold = s.docker.execStream.bind(s.docker);
    s.docker.execStream = async (spec) => {
      s.docker.execHold = spec.cmd[2] !== PROBE_SCRIPT;
      return hold(spec);
    };
    const d = await s.svc.dump('db');
    await d.abort();
    expect(s.docker.execAborts).toBe(1);
    expect((await d.finished).ok).toBe(false);
  });

  it('the reader going away stops a gzipped dump too, and the dump settles instead of hanging', async () => {
    const s = await setup('mysql:8', MY_TOOLS);
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(MY_TOOLS) }
        : {
            out: Buffer.from('-- MySQL dump 10.13\nCREATE TABLE t (id int);\n'),
          };
    const hold = s.docker.execStream.bind(s.docker);
    s.docker.execStream = async (spec) => {
      s.docker.execHold = spec.cmd[2] !== PROBE_SCRIPT;
      return hold(spec);
    };
    const d = await s.svc.dump('db');
    // a source that is destroyed does not end the gzip stream it was piped into: the dump must not wait for that
    const settled = await Promise.race([
      d.abort().then(() => 'aborted'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(settled).toBe('aborted');
    expect((await d.finished).ok).toBe(false);
  });

  it('only a fixed command runs in the container: the script, and one word for the mode', async () => {
    const s = await setup();
    await read((await s.svc.dump('db')).stream);
    for (const run of s.docker.execRuns) {
      expect(run.cmd[0]).toBe('sh');
      expect(run.cmd[1]).toBe('-c');
      expect(run.container).toBe('container-1');
    }
    const dump = s.docker.execRuns.at(-1)!;
    expect(dump.cmd).toHaveLength(5);
    expect(dump.cmd[3]).toBe('sh');
    expect(['dump-custom', 'dump-all']).toContain(dump.cmd[4]);
    // none of the app's settings, and none of its secrets, reach what is run
    expect(JSON.stringify(s.docker.execRuns)).not.toContain('hunter2');
    expect(JSON.stringify(s.docker.execRuns)).not.toContain('POSTGRES_USER=');
  });
});

describe('DatabaseBackupService.restore', () => {
  it('feeds a PostgreSQL custom dump to pg_restore as it arrives, and counts what went in', async () => {
    const s = await setup();
    const r = await s.svc.restore('db', body(PGDMP));
    expect(r).toEqual({ restored: true, bytes: PGDMP.length });
    expect(lastMode(s)).toBe('restore-custom');
    expect(s.docker.execInputs.at(-1)!.equals(PGDMP)).toBe(true);
  });

  it('unpacks gzip and restores the SQL inside', async () => {
    const s = await setup();
    const sql =
      '--\n-- PostgreSQL database dump\n--\nCREATE TABLE t (id int);\n';
    const gz = gzipSync(sql);
    const r = await s.svc.restore('db', body(gz));
    // counted as it was uploaded, packed
    expect(r.bytes).toBe(gz.length);
    expect(lastMode(s)).toBe('restore-sql');
    expect(s.docker.execInputs.at(-1)!.toString()).toBe(sql);
  });

  it('replacing needs the name of the app, and nothing is run without it', async () => {
    const s = await setup();
    await expect(
      s.svc.restore('db', body(PGDMP), { clean: true }),
    ).rejects.toThrow(ValidationError);
    await expect(
      s.svc.restore('db', body(PGDMP), { clean: true, confirm: 'other' }),
    ).rejects.toThrow(/confirm/);
    expect(s.docker.execRuns).toHaveLength(0);
    await s.svc.restore('db', body(PGDMP), { clean: true, confirm: 'db' });
    expect(lastMode(s)).toBe('restore-custom-clean');
  });

  it('MySQL: into what is there, replacing, and a dump of every database', async () => {
    const s = await setup('mariadb:11', MY_TOOLS);
    const one = '-- MariaDB dump 10.19\nCREATE TABLE t (id int);\n';
    await s.svc.restore('db', body(one));
    expect(lastMode(s)).toBe('restore');
    await s.svc.restore('db', body(one), { clean: true, confirm: 'db' });
    expect(lastMode(s)).toBe('restore-clean');
    const all =
      '-- MySQL dump 10.13\n-- Current Database: `a`\nCREATE DATABASE a;\n';
    await s.svc.restore('db', body(all));
    expect(lastMode(s)).toBe('restore-all');
    await expect(
      s.svc.restore('db', body(all), { clean: true, confirm: 'db' }),
    ).rejects.toThrow(/all databases/);
  });

  it('refuses a dump of another engine, and anything that is not a dump, before running anything', async () => {
    const pg = await setup();
    await expect(
      pg.svc.restore(
        'db',
        body('-- MySQL dump 10.13\nCREATE TABLE t (id int);'),
      ),
    ).rejects.toThrow(/written by MySQL/);
    await expect(
      pg.svc.restore('db', body(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]))),
    ).rejects.toThrow(/not a dump/);
    await expect(pg.svc.restore('db', body(''))).rejects.toThrow(
      ValidationError,
    );
    await expect(
      pg.svc.restore('db', body(gzipSync(gzipSync('select 1;')))),
    ).rejects.toThrow(/gzip inside gzip/);
    expect(
      pg.docker.execRuns.filter((r) => r.cmd[2] !== PROBE_SCRIPT),
    ).toHaveLength(0);

    const my = await setup('mysql:8', MY_TOOLS);
    await expect(my.svc.restore('db', body(PGDMP))).rejects.toThrow(
      /PostgreSQL dump/,
    );
    await expect(
      my.svc.restore('db', body('--\n-- PostgreSQL database dump\n--\n')),
    ).rejects.toThrow(/written by PostgreSQL/);
  });

  it('refuses a file that claims to be gzip and is not', async () => {
    const s = await setup();
    await expect(
      s.svc.restore('db', body(Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]))),
    ).rejects.toThrow(/cannot be unpacked/);
  });

  it('a tool that fails is a 422 with the end of its message, and never the secrets', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from(PG_TOOLS) }
        : {
            exit: 1,
            stderr: 'pg_restore: error: relation "t" already exists',
          };
    const e = await s.svc.restore('db', body(PGDMP)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).status).toBe(422);
    expect((e as DomainError).message).toMatch(/already exists/);
    expect((e as DomainError).message).not.toContain('hunter2');
    expect(JSON.stringify(s.docker.execRuns)).not.toContain('hunter2');
  });

  it('the upload being cancelled stops the tool', async () => {
    const s = await setup();
    const hold = s.docker.execStream.bind(s.docker);
    s.docker.execStream = async (spec) => {
      s.docker.execHold = spec.cmd[2] !== PROBE_SCRIPT;
      return hold(spec);
    };
    const ac = new AbortController();
    const p = s.svc.restore('db', body(PGDMP), { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(s.docker.execAborts).toBe(1);
  });

  it('is refused for an app that is not a database Provelox can restore into', async () => {
    const s = await setup('nginx:1.27');
    await expect(s.svc.restore('db', body(PGDMP))).rejects.toThrow(
      /does not look like a database/,
    );
  });
});
