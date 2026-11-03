import { Readable, Writable } from 'node:stream';
import type { Request, Response } from 'express';
import { ActivityService } from '../activity/activity.service';
import { TOKEN_SCOPE } from '../auth/scope.decorator';
import { makeStack } from '../test-utils';
import { ImportsService } from '../imports/imports.service';
import { DatabaseBackupService } from './database-backup.service';
import { DatabaseImportService } from './database-import.service';
import { DatabaseController } from './database.controller';
import { PROBE_SCRIPT } from './scripts';

const PGDMP = Buffer.from('PGDMP\u0001\u000e\u0000the-dump-bytes');

async function setup() {
  const s = makeStack();
  await s.apps.create({ name: 'db' });
  await s.apps.deploy('db', 'postgres:16');
  s.docker.containerIds.set('pvx-db', 'c1');
  s.docker.execScript = (spec) =>
    spec.cmd[2] === PROBE_SCRIPT
      ? { out: Buffer.from('pg_dump\npg_dumpall\npg_restore\npsql\n') }
      : { out: PGDMP };
  const svc = new DatabaseBackupService(s.apps, s.docker);
  const activity = new ActivityService(s.db, s.cfg);
  const folder = new ImportsService(s.docker, s.cfg);
  const imports = new DatabaseImportService(svc, folder);
  const controller = new DatabaseController(svc, activity, imports);
  const actor = { kind: 'admin', name: 'admin' };
  const req = { actor } as unknown as Request;
  return { ...s, controller, activity, req };
}

/** A response that keeps what was written, and says whether it was ended or cut off */
function fakeRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const w = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  const res = Object.assign(w, {
    set(h: Record<string, string>) {
      Object.assign(headers, h);
      return res;
    },
  });
  return {
    res: res as unknown as Response,
    chunks,
    headers,
    closed: new Promise<void>((r) => w.once('close', () => r())),
    raw: w,
  };
}

/** A request whose body is `bytes` */
const upload = (s: { req: Request }, bytes: Buffer | string) =>
  Object.assign(Readable.from([Buffer.from(bytes)]), {
    actor: (s.req as unknown as { actor: unknown }).actor,
    // a real request says so once the whole body has arrived; one that closes without it was cut off
    complete: true,
  }) as unknown as Request;

describe('the database routes are for the signed-in admin only', () => {
  it.each(['info', 'dump', 'exportDump', 'restore'] as const)(
    '%s has no token scope, so no access token can use it',
    (handler) => {
      expect(
        Reflect.getMetadata(TOKEN_SCOPE, DatabaseController.prototype[handler]),
      ).toBeUndefined();
    },
  );
});

describe('GET /apps/:name/database', () => {
  it('answers with the engine', async () => {
    const s = await setup();
    expect(await s.controller.info('db')).toEqual({
      engine: 'postgres',
      canBackup: true,
    });
  });
  it('is a conflict when the app is stopped', async () => {
    const s = await setup();
    s.docker.containerIds.clear();
    await expect(s.controller.info('db')).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('GET /apps/:name/database/dump', () => {
  it('sends the dump as an attachment and records who took it, without what was in it', async () => {
    const s = await setup();
    const r = fakeRes();
    await s.controller.dump('db', undefined, s.req, r.res);
    await r.closed;
    expect(Buffer.concat(r.chunks).equals(PGDMP)).toBe(true);
    expect(r.headers['Content-Type']).toBe('application/octet-stream');
    expect(r.headers['Content-Disposition']).toMatch(
      /^attachment; filename="db-\d{8}-\d{6}\.dump"$/,
    );
    expect(r.headers['Cache-Control']).toBe('no-store');
    const [e] = s.activity.list({ app: 'db' }).events;
    expect(e).toMatchObject({
      action: 'database.dump',
      target: 'db',
      outcome: 'ok',
    });
    expect(JSON.stringify(e)).not.toContain('the-dump-bytes');
  });

  it('?all=1 is a gzipped SQL file', async () => {
    const s = await setup();
    const r = fakeRes();
    await s.controller.dump('db', '1', s.req, r.res);
    await r.closed;
    expect(r.headers['Content-Type']).toBe('application/gzip');
    expect(r.headers['Content-Disposition']).toMatch(/\.sql\.gz"$/);
  });

  it('cuts the connection when the tool died half way', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from('pg_dump\npg_dumpall\npg_restore\npsql\n') }
        : { out: PGDMP, exit: 1, stderr: 'lost' };
    const r = fakeRes();
    await s.controller.dump('db', undefined, s.req, r.res);
    await r.closed;
    expect(r.raw.writableFinished).toBe(false);
    expect(r.raw.destroyed).toBe(true);
    expect(s.activity.list({ app: 'db' }).events[0]).toMatchObject({
      outcome: 'failed',
    });
  });

  it('sends nothing for an app that cannot be dumped', async () => {
    const s = await setup();
    s.docker.containerIds.clear();
    const r = fakeRes();
    await expect(
      s.controller.dump('db', undefined, s.req, r.res),
    ).rejects.toMatchObject({ status: 409 });
    expect(r.chunks).toHaveLength(0);
    expect(r.headers['Content-Type']).toBeUndefined();
  });
});

describe('POST /apps/:name/database/restore', () => {
  it('restores the body and answers with the result, recorded without content', async () => {
    const s = await setup();
    const out = await s.controller.restore(
      'db',
      undefined,
      undefined,
      undefined,
      upload(s, PGDMP),
    );
    expect(out).toEqual({ restored: true, bytes: PGDMP.length });
    const [e] = s.activity.list({ app: 'db' }).events;
    expect(e).toMatchObject({
      action: 'database.restore',
      outcome: 'ok',
      summary: 'restored into the database',
    });
  });

  it('replacing needs the app name, and says so as a 400', async () => {
    const s = await setup();
    await expect(
      s.controller.restore('db', '1', undefined, undefined, upload(s, PGDMP)),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.docker.execRuns).toHaveLength(0);
    const ok = await s.controller.restore(
      'db',
      '1',
      'db',
      undefined,
      upload(s, PGDMP),
    );
    expect(ok.restored).toBe(true);
    expect(s.activity.list({ app: 'db' }).events[0].summary).toBe(
      'replaced the contents of the database',
    );
  });

  it('a failed restore is recorded without the tool output, and passes the error on', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from('pg_dump\npg_dumpall\npg_restore\npsql\n') }
        : { exit: 1, stderr: 'ERROR: duplicate key value (secret-row-42)' };
    await expect(
      s.controller.restore(
        'db',
        undefined,
        undefined,
        undefined,
        upload(s, PGDMP),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const [e] = s.activity.list({ app: 'db' }).events;
    expect(e).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(e)).not.toContain('secret-row-42');
  });

  it('refuses a dump of the wrong engine as a 400', async () => {
    const s = await setup();
    await expect(
      s.controller.restore(
        'db',
        undefined,
        undefined,
        undefined,
        upload(s, '-- MySQL dump 10.13\nCREATE TABLE t (id int);'),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/** A listing the helper prints: the fake docker answers helpers in the order they start */
const LISTING = (files: string[][]) =>
  files.map((f) => `F\t${f.join('\t')}`).join('\n') + '\nD\t1048576\n';

describe('POST /apps/:name/database/export', () => {
  it('saves a dump into the folder and answers with the file, recorded without content', async () => {
    const s = await setup();
    // the folder is prepared, the dump is written to a part file, the part file is moved into place
    s.docker.streamPlan = [
      { bytes: '' }, // ensure
      { bytes: `size=${PGDMP.length}\n` }, // write the part file
      { bytes: '' }, // finish
    ];
    const out = await s.controller.exportDump('db', undefined, s.req);
    expect(out.file).toMatch(/^db-\d{8}-\d{6}\.dump$/);
    expect(out.sizeBytes).toBe(PGDMP.length);
    expect(out.dir).toBe(s.cfg.IMPORTS_DIR);
    // the dump bytes went to the helper that writes the file
    expect(s.docker.streamReceived.some((b) => b.equals(PGDMP))).toBe(true);
    const [e] = s.activity.list({ app: 'db' }).events;
    expect(e).toMatchObject({ action: 'database.export', outcome: 'ok' });
    expect(JSON.stringify(e)).not.toContain('the-dump-bytes');
  });

  it('?all=1 saves a gzipped SQL file', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: 'size=20\n' },
      { bytes: '' },
    ];
    const out = await s.controller.exportDump('db', '1', s.req);
    expect(out.file).toMatch(/\.sql\.gz$/);
  });

  it('a dump that died leaves no file: the part file is removed and nothing is moved into place', async () => {
    const s = await setup();
    s.docker.execScript = (spec) =>
      spec.cmd[2] === PROBE_SCRIPT
        ? { out: Buffer.from('pg_dump\npg_dumpall\npg_restore\npsql\n') }
        : { out: PGDMP, exit: 1, stderr: 'connection lost (secret-row-42)' };
    s.docker.streamPlan = [
      { bytes: '' }, // ensure
      { bytes: `size=${PGDMP.length}\n` }, // write
      { bytes: '' }, // discard
    ];
    await expect(
      s.controller.exportDump('db', undefined, s.req),
    ).rejects.toMatchObject({ status: 503 });
    const scripts = s.docker.streamRuns.map((r) => r.command[1] ?? '');
    expect(scripts.some((c) => c.includes('mv '))).toBe(false);
    expect(scripts.at(-1)).toMatch(/rm -f/);
    const [e] = s.activity.list({ app: 'db' }).events;
    expect(e).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(e)).not.toContain('secret-row-42');
  });

  it('an app that is not running is refused before any file is made', async () => {
    const s = await setup();
    s.docker.containerIds.clear();
    await expect(
      s.controller.exportDump('db', undefined, s.req),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.docker.streamRuns).toHaveLength(0);
  });
});

describe('POST /apps/:name/database/restore?from=', () => {
  /** A request with no body, as a plain POST */
  const bare = (s: { req: Request }) =>
    ({
      actor: (s.req as unknown as { actor: unknown }).actor,
      headers: {},
    }) as unknown as Request;

  it('restores a dump that is in the folder and records the file name', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' }, // ensure
      { bytes: LISTING([['db-1.dump', '31', '1760000000', '0']]) }, // list
      { bytes: PGDMP }, // the file, read by the helper
    ];
    const out = await s.controller.restore(
      'db',
      undefined,
      undefined,
      'db-1.dump',
      bare(s),
    );
    expect(out).toEqual({
      restored: true,
      file: 'db-1.dump',
      bytes: PGDMP.length,
    });
    expect(s.docker.execInputs.at(-1)?.equals(PGDMP)).toBe(true);
    // the folder is only ever mounted read-only for this
    const reads = s.docker.streamRuns.filter((r) => r.mounts[0].readOnly);
    expect(reads.length).toBeGreaterThan(0);
    expect(s.activity.list({ app: 'db' }).events[0]).toMatchObject({
      action: 'database.restore',
      outcome: 'ok',
      summary: expect.stringContaining('db-1.dump'),
    });
  });

  it('refuses a body together with from, with a 400', async () => {
    const s = await setup();
    const withBody = {
      actor: (s.req as unknown as { actor: unknown }).actor,
      headers: { 'content-length': '10' },
    } as unknown as Request;
    await expect(
      s.controller.restore('db', undefined, undefined, 'db-1.dump', withBody),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('a file that is not in the folder is a 404, and nothing is read', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: LISTING([]) }];
    await expect(
      s.controller.restore('db', undefined, undefined, 'gone.dump', bare(s)),
    ).rejects.toMatchObject({ status: 404 });
    expect(s.docker.execRuns.filter((r) => r.input)).toHaveLength(0);
  });

  it('refuses a volume archive, a traversal and a path as a 400, before the folder is even looked at', async () => {
    const s = await setup();
    for (const bad of [
      'data.tar.gz',
      'data.tgz',
      '../etc/passwd',
      '..%2Fx.dump',
      '/etc/passwd',
      'a/b.dump',
      '.hidden.dump',
      'x.txt',
    ])
      await expect(
        s.controller.restore('db', undefined, undefined, bad, bare(s)),
      ).rejects.toMatchObject({ status: 400 });
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('replacing from a file needs the app name, as a 400, before anything is read', async () => {
    const s = await setup();
    await expect(
      s.controller.restore('db', '1', undefined, 'db-1.dump', bare(s)),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('a dump of the wrong engine is refused with the database untouched (the tool is never started)', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: LISTING([['x.sql', '40', '1760000000', '0']]) },
      { bytes: '-- MySQL dump 10.13\nCREATE TABLE t (id int);\n' },
    ];
    await expect(
      s.controller.restore('db', undefined, undefined, 'x.sql', bare(s)),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      s.docker.execRuns.filter((r) => r.cmd[2] !== PROBE_SCRIPT),
    ).toHaveLength(0);
    // and the helper that was reading the file is stopped
    expect(s.docker.streamAborts).toBeGreaterThan(0);
  });

  it('a file that could not be read to the end is reported, since the tool could have seen a short dump', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: LISTING([['db-1.dump', '31', '1760000000', '0']]) },
      { bytes: PGDMP, exit: 1, stderr: 'cat: read error' },
    ];
    await expect(
      s.controller.restore('db', undefined, undefined, 'db-1.dump', bare(s)),
    ).rejects.toMatchObject({ status: 422 });
  });
});
