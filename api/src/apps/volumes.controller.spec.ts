import { Readable, Writable } from 'node:stream';
import type { Request, Response } from 'express';
import { ActivityService } from '../activity/activity.service';
import { makeStack } from '../test-utils';
import { ImportsService } from '../imports/imports.service';
import { VolumeDownloadService } from './volume-download.service';
import { VolumeImportService } from './volume-import.service';
import { VolumeRestoreService } from './volume-restore.service';
import { VolumesController } from './volumes.controller';

async function setup() {
  const s = makeStack();
  await s.apps.create({ name: 'files', persistent: true });
  await s.apps.update('files', {
    volumes: [{ containerPath: '/data', volumeName: 'data' }],
  });
  await s.apps.deploy('files', 'x/y:1');
  s.docker.volumes.set('pvx-files-data', {});
  const dl = new VolumeDownloadService(s.apps, s.docker, s.cfg);
  dl.pollMs = 1;
  dl.waitMs = 30;
  const activity = new ActivityService(s.db, s.cfg);
  const rs = new VolumeRestoreService(dl, s.apps, s.docker, s.cfg);
  rs.pollMs = 1;
  rs.waitMs = 30;
  const imports = new ImportsService(s.docker, s.cfg);
  const vi = new VolumeImportService(dl, imports, s.apps, s.docker, s.cfg);
  vi.pollMs = 1;
  vi.waitMs = 30;
  const controller = new VolumesController(
    s.migration,
    s.mounts,
    dl,
    rs,
    vi,
    activity,
  );
  const req = { actor: { kind: 'admin', name: 'admin' } } as unknown as Request;
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

describe('GET /apps/:name/volumes/:volume/download', () => {
  it('answers with a gzip attachment and the archive, and records who took it', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.from('ARCHIVE-BYTES-ARCHIVE');
    const r = fakeRes();
    await s.controller.download('files', 'data', undefined, s.req, r.res);
    await r.closed;
    expect(Buffer.concat(r.chunks).toString()).toBe('ARCHIVE-BYTES-ARCHIVE');
    expect(r.headers['Content-Type']).toBe('application/gzip');
    expect(r.headers['Content-Disposition']).toMatch(
      /^attachment; filename="files-data-\d{8}-\d{6}\.tar\.gz"$/,
    );
    expect(r.headers['Cache-Control']).toBe('no-store');
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({
      action: 'volume.download',
      target: 'files',
      outcome: 'ok',
      summary: 'downloaded volume "data"',
    });
    // what was in the archive is never part of the record
    expect(JSON.stringify(e)).not.toContain('ARCHIVE');
  });

  it('cuts the connection, rather than ending it, when the copy died half way', async () => {
    const s = await setup();
    s.docker.streamExit = 137;
    const r = fakeRes();
    await s.controller.download('files', 'data', undefined, s.req, r.res);
    await r.closed;
    expect(r.raw.writableFinished).toBe(false);
    expect(r.raw.destroyed).toBe(true);
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({ outcome: 'failed' });
  });

  it('stops the copy when the client goes away, and starts a stopped app again', async () => {
    const s = await setup();
    s.docker.streamHold = true;
    const r = fakeRes();
    const pending = s.controller.download('files', 'data', '1', s.req, r.res);
    // the app is stopped while the copy runs
    await new Promise((x) => setTimeout(x, 20));
    expect(s.repo.get('files')?.instanceCount).toBe(0);
    r.raw.destroy();
    await pending;
    expect(s.docker.streamAborts).toBe(1);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e.summary).toMatch(/cancelled/);
  });

  it('notes in the record that the app was stopped for the copy', async () => {
    const s = await setup();
    const r = fakeRes();
    await s.controller.download('files', 'data', '1', s.req, r.res);
    await r.closed;
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e.summary).toBe(
      'downloaded volume "data" (the app was stopped for the copy)',
    );
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });

  it('refuses before sending anything for an unknown volume', async () => {
    const s = await setup();
    const r = fakeRes();
    await expect(
      s.controller.download('files', 'pvx-files-data', undefined, s.req, r.res),
    ).rejects.toThrow(/no volume named/);
    expect(r.chunks).toHaveLength(0);
    expect(r.headers['Content-Type']).toBeUndefined();
  });
});

const gzBody = (rest = 'archive') =>
  Readable.from([
    Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from(rest)]),
  ]);

describe('POST /apps/:name/volumes/:volume/restore', () => {
  it('is for the administrator only: no token scope is granted to it', async () => {
    const { TOKEN_SCOPE } = await import('../auth/scope.decorator');
    expect(
      Reflect.getMetadata(TOKEN_SCOPE, VolumesController.prototype.restore),
    ).toBeUndefined();
    expect(Reflect.getMetadata(TOKEN_SCOPE, VolumesController)).toBeUndefined();
  });

  it('restores the body into an empty volume and records who did it, without the content', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.alloc(0);
    const body = gzBody('SECRET-DATA');
    const r = await s.controller.restore(
      'files',
      'data',
      undefined,
      undefined,
      undefined,
      Object.assign(body, s.req) as unknown as Request,
    );
    expect(r).toMatchObject({ restored: true, replaced: false });
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({
      action: 'volume.restore',
      target: 'files',
      outcome: 'ok',
      summary: 'restored volume "data"',
    });
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });

  it('passes replace and its confirmation on, and says so in the record', async () => {
    const s = await setup();
    const r = await s.controller.restore(
      'files',
      'data',
      '1',
      'files',
      undefined,
      Object.assign(gzBody(), s.req) as unknown as Request,
    );
    expect(r.replaced).toBe(true);
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e.summary).toBe('restored volume "data" (replacing what was there)');
  });

  it('answers 400 for replace without the confirmation, and records the failure', async () => {
    const s = await setup();
    await expect(
      s.controller.restore(
        'files',
        'data',
        '1',
        'nope',
        undefined,
        Object.assign(gzBody(), s.req) as unknown as Request,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({ outcome: 'failed', action: 'volume.restore' });
    expect(s.docker.streamRuns).toHaveLength(0);
  });

  it('answers 409 for a volume that is not empty, 404 for an unknown one, 400 for a file that is not gzip', async () => {
    const s = await setup();
    s.docker.streamBytes = Buffer.from('x\n');
    const call = (vol: string, body: Readable) =>
      s.controller.restore(
        'files',
        vol,
        undefined,
        undefined,
        undefined,
        Object.assign(body, s.req) as unknown as Request,
      );
    await expect(call('data', gzBody())).rejects.toMatchObject({ status: 409 });
    await expect(call('nope', gzBody())).rejects.toMatchObject({ status: 404 });
    await expect(
      call('data', Readable.from([Buffer.from('plain text')])),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });
});

/** A request as Express hands it over: the actor and the headers, and no body */
const reqWith = (
  s: { req: Request },
  headers: Record<string, string> = {},
): Request => Object.assign({}, s.req, { headers }) as unknown as Request;
const F = (name: string, size = 100) => `F\t${name}\t${size}\t1700000000\t1`;

describe('POST /apps/:name/volumes/:volume/restore?from=<file in the import folder>', () => {
  it('restores a file that is in the folder and records it, with the file name and without any content', async () => {
    const s = await setup();
    // prepare the folder, list it, look in the (empty) volume, then restore
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `${F('shop.tar.gz', 4321)}\nD\t1000000\n` },
      { bytes: '' },
      {},
    ];
    const r = await s.controller.restore(
      'files',
      'data',
      undefined,
      undefined,
      'shop.tar.gz',
      reqWith(s),
    );
    expect(r).toMatchObject({
      restored: true,
      file: 'shop.tar.gz',
      bytes: 4321,
      replaced: false,
    });
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({
      action: 'volume.restore',
      target: 'files',
      outcome: 'ok',
      summary: 'restored volume "data" from the server file "shop.tar.gz"',
    });
  });

  it('says in the record that it replaced what was there', async () => {
    const s = await setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `${F('shop.tar.gz')}\nD\t1000000\n` },
      {},
    ];
    await s.controller.restore(
      'files',
      'data',
      '1',
      'files',
      'shop.tar.gz',
      reqWith(s),
    );
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e.summary).toBe(
      'restored volume "data" from the server file "shop.tar.gz" (replacing what was there)',
    );
  });

  it('refuses a body together with from, with 400, and runs nothing', async () => {
    const s = await setup();
    await expect(
      s.controller.restore(
        'files',
        'data',
        undefined,
        undefined,
        'shop.tar.gz',
        reqWith(s, { 'content-length': '10' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.controller.restore(
        'files',
        'data',
        undefined,
        undefined,
        'shop.tar.gz',
        reqWith(s, { 'transfer-encoding': 'chunked' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.docker.streamRuns).toHaveLength(0);
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({ outcome: 'failed', action: 'volume.restore' });
  });

  it('answers 404 for a file the folder does not hold, and 400 for a name that is a path', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'D\t1000\n' }];
    const call = (from: string) =>
      s.controller.restore(
        'files',
        'data',
        undefined,
        undefined,
        from,
        reqWith(s),
      );
    await expect(call('missing.tar.gz')).rejects.toMatchObject({ status: 404 });
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/b.tar.gz', ''])
      await expect(call(bad)).rejects.toMatchObject({ status: 400 });
    expect(s.repo.get('files')?.instanceCount).toBe(1);
  });
});

describe('POST /apps/:name/volumes/:volume/export', () => {
  it('is for the administrator only: no token scope is granted to it', async () => {
    const { TOKEN_SCOPE } = await import('../auth/scope.decorator');
    expect(
      Reflect.getMetadata(
        TOKEN_SCOPE,
        VolumesController.prototype.exportVolume,
      ),
    ).toBeUndefined();
  });

  it('saves a copy into the folder and records it, with the file name', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=2048\n' }];
    const r = await s.controller.exportVolume(
      'files',
      'data',
      undefined,
      reqWith(s),
    );
    expect(r).toMatchObject({
      sizeBytes: 2048,
      dir: '/var/lib/provelox/imports',
      stopped: false,
    });
    expect(r.file).toMatch(/^files-data-\d{8}-\d{6}\.tar\.gz$/);
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({
      action: 'volume.export',
      target: 'files',
      outcome: 'ok',
    });
    expect(e.summary).toContain(r.file);
  });

  it('with stop=1 stops the app for the copy and says so, and a failure is recorded and starts the app again', async () => {
    const s = await setup();
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'size=1\n' }];
    const ok = await s.controller.exportVolume(
      'files',
      'data',
      '1',
      reqWith(s),
    );
    expect(ok.stopped).toBe(true);
    expect(s.activity.list({ app: 'files' }).events[0].summary).toContain(
      'the app was stopped for the copy',
    );
    s.docker.streamPlan = [{ exit: 2, stderr: 'No space left on device' }];
    await expect(
      s.controller.exportVolume('files', 'data', '1', reqWith(s)),
    ).rejects.toThrow(/No space left/);
    expect(s.repo.get('files')?.instanceCount).toBe(1);
    const [e] = s.activity.list({ app: 'files' }).events;
    expect(e).toMatchObject({ outcome: 'failed', action: 'volume.export' });
  });

  it('answers 404 for a volume the app does not have', async () => {
    const s = await setup();
    await expect(
      s.controller.exportVolume('files', 'nope', undefined, reqWith(s)),
    ).rejects.toMatchObject({ status: 404 });
  });
});
