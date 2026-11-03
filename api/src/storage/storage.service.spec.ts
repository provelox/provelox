import { NotFoundError, ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';

const OURS = { 'io.provelox.managed': 'true' };
const ANON = 'b'.repeat(64);

async function setup() {
  const s = makeStack();
  // an app with a declared volume, and a deployed history
  await s.apps.create({ name: 'db', persistent: true });
  await s.apps.update('db', {
    volumes: [{ containerPath: '/d', volumeName: 'data' }],
  });
  for (const n of [1, 2, 3, 4]) await s.apps.deploy('db', `acme/db:${n}`);
  s.docker.host = {
    volumes: [
      { name: 'pvx-db-data', labels: OURS, sizeBytes: 500 }, // declared by the app
      {
        name: 'pvx-gone-data',
        labels: { ...OURS, 'io.provelox.app': 'gone' },
        sizeBytes: 300,
      }, // our orphan
      { name: ANON, labels: {}, sizeBytes: 200 }, // not ours
      { name: 'busy', labels: OURS, sizeBytes: 100 }, // in use
    ],
    containers: [
      {
        id: 'c',
        name: 'c',
        imageId: 'sha256:running',
        imageName: 'acme/db:4',
        mounts: [{ type: 'volume', name: 'busy' }],
      },
    ],
    images: [
      {
        id: 'sha256:running',
        tags: ['acme/db:4'],
        sizeBytes: 1000,
        createdAt: 1,
      },
      { id: 'sha256:v3', tags: ['acme/db:3'], sizeBytes: 900, createdAt: 1 },
      { id: 'sha256:v1', tags: ['acme/db:1'], sizeBytes: 800, createdAt: 1 },
      { id: 'sha256:mysql', tags: ['mysql:8'], sizeBytes: 700, createdAt: 1 },
      {
        id: 'sha256:traefik',
        tags: ['traefik:v3.6'],
        sizeBytes: 600,
        createdAt: 1,
      },
    ],
  };
  return s;
}

describe('StorageService.report', () => {
  it('classifies volumes and images with what we can prove', async () => {
    const { storage } = await setup();
    const r = await storage.report(1);
    const kind = (
      xs: { name?: string; id?: string; kind: string }[],
      k: string,
    ) => xs.find((x) => (x.name ?? x.id) === k)?.kind;
    expect(kind(r.volumes, 'pvx-db-data')).toBe('declared');
    expect(kind(r.volumes, 'pvx-gone-data')).toBe('provelox-orphan');
    expect(kind(r.volumes, ANON)).toBe('unnamed-orphan');
    expect(kind(r.volumes, 'busy')).toBe('in-use');
    expect(kind(r.images, 'sha256:running')).toBe('in-use');
    expect(kind(r.images, 'sha256:v3')).toBe('kept-version');
    expect(kind(r.images, 'sha256:v1')).toBe('old-version');
    expect(kind(r.images, 'sha256:mysql')).toBe('other-unused');
    expect(kind(r.images, 'sha256:traefik')).toBe('system');
  });
  it('sums what can be reclaimed, split by certainty', async () => {
    const { storage } = await setup();
    const r = await storage.report(1);
    expect(r.reclaimable.volumes).toEqual({ provable: 300, needsAck: 200 });
    expect(r.reclaimable.images).toEqual({ provable: 800, needsAck: 700 });
  });
  it('keeps more or fewer versions as asked', async () => {
    const { storage } = await setup();
    expect(
      (await storage.report(0)).images.find((i) => i.id === 'sha256:v3')?.kind,
    ).toBe('old-version');
    expect(
      (await storage.report(3)).images.find((i) => i.id === 'sha256:v1')?.kind,
    ).toBe('kept-version');
    await expect(storage.report(-1)).rejects.toBeInstanceOf(ValidationError);
    await expect(storage.report(NaN)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('StorageService.deleteVolumes', () => {
  it('deletes what is provably ours', async () => {
    const { storage, docker } = await setup();
    const r = await storage.deleteVolumes(['pvx-gone-data'], false);
    expect(r.deleted).toEqual(['pvx-gone-data']);
    expect(docker.removed).toEqual(['volume:pvx-gone-data']);
  });
  it('never deletes a declared or in-use volume, even when asked and acknowledged', async () => {
    const { storage, docker } = await setup();
    const r = await storage.deleteVolumes(['pvx-db-data', 'busy'], true);
    expect(r.deleted).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(['pvx-db-data', 'busy']);
    expect(docker.removed).toEqual([]);
  });
  it('needs an acknowledgement for volumes of unknown origin', async () => {
    const { storage, docker } = await setup();
    const no = await storage.deleteVolumes([ANON], false);
    expect(no.deleted).toEqual([]);
    expect(no.skipped[0].reason).toMatch(/confirm/);
    expect(docker.removed).toEqual([]);
    const yes = await storage.deleteVolumes([ANON], true);
    expect(yes.deleted).toEqual([ANON]);
  });
  it('re-checks at delete time: a volume that became in use since the report is skipped', async () => {
    const { storage, docker } = await setup();
    const before = await storage.report();
    expect(before.volumes.find((v) => v.name === 'pvx-gone-data')?.delete).toBe(
      'yes',
    );
    docker.host.containers.push({
      id: 'new',
      name: 'new',
      imageId: 'i',
      imageName: 'i',
      mounts: [{ type: 'volume', name: 'pvx-gone-data' }],
    });
    const r = await storage.deleteVolumes(['pvx-gone-data'], true);
    expect(r.deleted).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/using it/);
  });
  it('reports names that do not exist and tolerates duplicates', async () => {
    const { storage } = await setup();
    const r = await storage.deleteVolumes(
      ['nope', 'pvx-gone-data', 'pvx-gone-data'],
      false,
    );
    expect(r.deleted).toEqual(['pvx-gone-data']);
    expect(r.skipped).toEqual([
      { id: 'nope', reason: 'It does not exist (any more).' },
    ]);
  });
  it('reports Docker refusing, and carries on with the rest', async () => {
    const { storage, docker } = await setup();
    docker.host.volumes.push({ name: 'pvx-other-data', labels: OURS });
    docker.refuseRemoval.add('pvx-gone-data');
    const r = await storage.deleteVolumes(
      ['pvx-gone-data', 'pvx-other-data'],
      false,
    );
    expect(r.deleted).toEqual(['pvx-other-data']);
    expect(r.skipped[0]).toEqual({
      id: 'pvx-gone-data',
      reason: 'volume is in use',
    });
  });
});

describe('StorageService.deleteImages', () => {
  it('deletes old versions only, keeps the recent ones and the running one', async () => {
    const { storage, docker } = await setup();
    const r = await storage.deleteImages(
      ['sha256:v1', 'sha256:v3', 'sha256:running', 'sha256:traefik'],
      1,
      false,
    );
    expect(r.deleted).toEqual(['sha256:v1']);
    expect(r.skipped.map((s) => s.id)).toEqual([
      'sha256:v3',
      'sha256:running',
      'sha256:traefik',
    ]);
    expect(docker.removed).toEqual(['image:sha256:v1']);
  });
  it('needs an acknowledgement for images nothing here deployed', async () => {
    const { storage } = await setup();
    expect(
      (await storage.deleteImages(['sha256:mysql'], 1, false)).deleted,
    ).toEqual([]);
    expect(
      (await storage.deleteImages(['sha256:mysql'], 1, true)).deleted,
    ).toEqual(['sha256:mysql']);
  });
  it('uses the keepVersions given now, not an earlier one', async () => {
    const { storage } = await setup();
    expect(
      (await storage.deleteImages(['sha256:v3'], 0, false)).deleted,
    ).toEqual(['sha256:v3']);
  });
});

describe('StorageService: totals and peek', () => {
  it('adds totals to the report', async () => {
    const { storage } = await setup();
    const r = await storage.report(1);
    expect(r.totals).toEqual({
      imagesBytes: 1000 + 900 + 800 + 700 + 600,
      containers: 1,
      volumesBytes: 500 + 300 + 200 + 100,
    });
  });

  it('lists a volume read-only through a helper with no way to write', async () => {
    const { storage, docker } = await setup();
    docker.helperResult = {
      exitCode: 0,
      output: 'total 0\n-rw-r--r-- 1 root root 5 file.db\n',
    };
    const r = await storage.peek('pvx-gone-data');
    expect(r.listing).toContain('file.db');
    expect(docker.helperRuns.at(-1)?.mounts).toEqual([
      { volume: 'pvx-gone-data', target: '/x', readOnly: true },
    ]);
  });

  it('refuses unknown volumes and reports a failing read', async () => {
    const { storage, docker } = await setup();
    await expect(storage.peek('nope')).rejects.toBeInstanceOf(NotFoundError);
    docker.helperResult = { exitCode: 1, output: 'boom' };
    await expect(storage.peek('pvx-gone-data')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('StorageService: summary and prune', () => {
  it('summarises sizes, the biggest items and what is provably clearable', async () => {
    const { storage } = await setup();
    const s = await storage.summary();
    expect(s.imagesBytes).toBe(4000);
    expect(s.volumesBytes).toBe(1100);
    expect(s.topImages[0]).toMatchObject({
      name: 'acme/db:4',
      sizeBytes: 1000,
    });
    expect(s.topVolumes[0]).toMatchObject({
      name: 'pvx-db-data',
      sizeBytes: 500,
    });
    expect(s.topVolumes.find((v) => v.name === 'busy')?.inUse).toBe(true);
    // v1 is an old version of an app of ours: certain. mysql and the volume nobody owns are not.
    expect(s.reclaimableImagesBytes).toBe(800);
  });

  it('keeps a reading for a short while', async () => {
    const { storage, docker } = await setup();
    const t = Date.now();
    await storage.summary(t);
    docker.host.images = [];
    expect((await storage.summary(t + 1000)).imagesBytes).toBe(4000);
    expect((await storage.summary(t + 60_000)).imagesBytes).toBe(0);
  });

  it('prunes only what is provably unused, never what needs confirming', async () => {
    const { storage, docker } = await setup();
    const r = await storage.pruneImages();
    expect(r).toEqual({ deleted: 1, freedBytes: 800, skipped: 0 });
    expect(docker.removed).toEqual(['image:sha256:v1']);
  });
});
