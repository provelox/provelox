import type { Request } from 'express';
import { ActivityService } from '../activity/activity.service';
import { makeStack } from '../test-utils';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

const F = (name: string, size = 100) => `F\t${name}\t${size}\t1700000000\t1`;

function setup() {
  const s = makeStack();
  const imports = new ImportsService(s.docker, s.cfg);
  const activity = new ActivityService(s.db, s.cfg);
  const controller = new ImportsController(imports, activity);
  const req = { actor: { kind: 'admin', name: 'admin' } } as unknown as Request;
  return { ...s, controller, activity, req };
}

describe('the import folder endpoints', () => {
  it('are for the administrator only: no token scope is granted to any of them', async () => {
    const { TOKEN_SCOPE } = await import('../auth/scope.decorator');
    expect(Reflect.getMetadata(TOKEN_SCOPE, ImportsController)).toBeUndefined();
    for (const m of ['list', 'remove'] as const)
      expect(
        Reflect.getMetadata(TOKEN_SCOPE, ImportsController.prototype[m]),
      ).toBeUndefined();
  });

  it('GET lists the folder, where it is, and the free space', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `${F('a.tar.gz', 5)}\nD\t2\n` },
    ];
    expect(await s.controller.list()).toEqual({
      dir: '/var/lib/provelox/imports',
      files: [
        {
          name: 'a.tar.gz',
          sizeBytes: 5,
          modifiedAt: '2023-11-14T22:13:20.000Z',
          gzip: true,
          kind: 'volume',
        },
      ],
      freeBytes: 2048,
    });
  });

  it('DELETE removes a file once its name is confirmed, and records who did it', async () => {
    const s = setup();
    s.docker.streamPlan = [
      { bytes: '' },
      { bytes: `${F('a.tar.gz')}\nD\t2\n` },
      {},
    ];
    expect(await s.controller.remove('a.tar.gz', 'a.tar.gz', s.req)).toEqual({
      removed: true,
    });
    const [e] = s.activity.list({}).events;
    expect(e).toMatchObject({
      action: 'import.delete',
      outcome: 'ok',
      summary: 'deleted a.tar.gz from the import folder',
    });
  });

  it('DELETE answers 400 without the confirmation or for a name that is a path, 404 for one that is not there, and records the failure', async () => {
    const s = setup();
    await expect(
      s.controller.remove('a.tar.gz', undefined, s.req),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.controller.remove('../x.tar.gz', '../x.tar.gz', s.req),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.docker.streamRuns).toHaveLength(0);
    s.docker.streamPlan = [{ bytes: '' }, { bytes: 'D\t2\n' }];
    await expect(
      s.controller.remove('gone.tar.gz', 'gone.tar.gz', s.req),
    ).rejects.toMatchObject({ status: 404 });
    const [e] = s.activity.list({}).events;
    expect(e).toMatchObject({ action: 'import.delete', outcome: 'failed' });
  });
});
