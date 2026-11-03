import {
  classifyImages,
  classifyVolumes,
  imageRepository,
  summarizeReclaimable,
  type AppFact,
  type ContainerFact,
  type ImageFact,
  type VolumeFact,
} from './storage-classifier';

const vol = (
  name: string,
  labels: Record<string, string> = {},
  sizeBytes = 100,
): VolumeFact => ({ name, labels, sizeBytes });
const ctr = (over: Partial<ContainerFact> = {}): ContainerFact => ({
  id: 'c1',
  name: 'c1',
  imageId: 'sha256:x',
  imageName: 'x:1',
  mounts: [],
  ...over,
});
const app = (over: Partial<AppFact> = {}): AppFact => ({
  appName: 'site',
  deployedVersion: 5,
  versions: [],
  volumeNames: [],
  ...over,
});
const img = (id: string, tags: string[], sizeBytes = 1000): ImageFact => ({
  id,
  tags,
  sizeBytes,
  createdAt: 1,
});
const OURS = { 'io.provelox.managed': 'true' };
const ANON = 'a'.repeat(64);

describe('classifyVolumes', () => {
  const one = (v: VolumeFact, cs: ContainerFact[] = [], as: AppFact[] = []) =>
    classifyVolumes([v], cs, as)[0];

  it('never offers a volume a container is using', () => {
    const r = one(vol('pvx-site-data', OURS), [
      ctr({
        mounts: [{ type: 'volume', name: 'pvx-site-data' }],
        service: 'pvx-site',
      }),
    ]);
    expect(r).toMatchObject({ kind: 'in-use', delete: 'no' });
    expect(r.usedBy).toEqual([{ container: 'c1', service: 'pvx-site' }]);
  });
  it('never offers a volume an app still declares, even when it is stopped', () => {
    const r = one(
      vol('pvx-site-data', OURS),
      [],
      [app({ volumeNames: ['pvx-site-data'] })],
    );
    expect(r).toMatchObject({ kind: 'declared', delete: 'no', app: 'site' });
  });
  it('declared beats the managed label (a stopped app must keep its data)', () => {
    expect(
      one(
        vol('pvx-p-d', { ...OURS, 'io.provelox.project': 'p' }),
        [],
        [app({ appName: 'p-db', project: 'p', volumeNames: ['pvx-p-d'] })],
      ),
    ).toMatchObject({
      kind: 'declared',
      project: 'p',
    });
  });
  it('offers our own orphans without question', () => {
    expect(
      one(vol('pvx-old-data', { ...OURS, 'io.provelox.app': 'old' })),
    ).toMatchObject({
      kind: 'provelox-orphan',
      delete: 'yes',
      app: 'old',
    });
  });
  it('needs an acknowledgement for anything we cannot prove is ours', () => {
    expect(one(vol(ANON))).toMatchObject({
      kind: 'unnamed-orphan',
      delete: 'acknowledge',
    });
    expect(one(vol('someone-elses-data'))).toMatchObject({
      kind: 'named-orphan',
      delete: 'acknowledge',
    });
  });
  it('does not trust a label that merely says "false"', () => {
    expect(one(vol('x', { 'io.provelox.managed': 'false' })).delete).toBe(
      'acknowledge',
    );
  });
  it('ignores bind mounts and nameless mounts when working out usage', () => {
    const r = one(vol('v'), [
      ctr({ mounts: [{ type: 'bind' }, { type: 'volume' }] }),
    ]);
    expect(r.kind).toBe('named-orphan');
  });
});

describe('classifyVolumes: migration lineage', () => {
  const migrated = vol('pvx-files-data', {
    ...OURS,
    'io.provelox.app': 'files',
    'io.provelox.migrated-from': ANON,
  });
  it('offers the original of a finished migration, since our own label on the copy proves it was ours', () => {
    const [orig] = classifyVolumes(
      [vol(ANON), migrated],
      [],
      [app({ appName: 'files', volumeNames: ['pvx-files-data'] })],
    );
    expect(orig).toMatchObject({
      kind: 'migration-original',
      delete: 'yes',
      app: 'files',
      copiedTo: 'pvx-files-data',
    });
  });
  it('never offers an original a container still uses', () => {
    const c = ctr({ mounts: [{ type: 'volume', name: ANON }] });
    expect(classifyVolumes([vol(ANON), migrated], [c], [])[0]).toMatchObject({
      kind: 'in-use',
      delete: 'no',
    });
  });
  it('ignores a migrated-from label on a volume that is not ours', () => {
    const forged = vol('x', { 'io.provelox.migrated-from': ANON });
    expect(classifyVolumes([vol(ANON), forged], [], [])[0]).toMatchObject({
      kind: 'unnamed-orphan',
      delete: 'acknowledge',
    });
  });
});

describe('classifyImages', () => {
  const run = (
    images: ImageFact[],
    cs: ContainerFact[] = [],
    as: AppFact[] = [],
    keep = 1,
    system: string[] = [],
  ) => classifyImages(images, cs, as, keep, system);

  it('never offers an image a container uses, by id or by tag', () => {
    expect(run([img('sha256:x', ['x:1'])], [ctr()])[0]).toMatchObject({
      kind: 'in-use',
      delete: 'no',
    });
    expect(run([img('sha256:other', ['x:1'])], [ctr()])[0].kind).toBe('in-use');
  });
  it('never offers the platform images, whatever their tag', () => {
    expect(
      run([img('i', ['traefik:v3.6'])], [], [], 1, ['traefik:v3.1'])[0],
    ).toMatchObject({ kind: 'system', delete: 'no' });
  });
  it('keeps the deployed version and the N before it, offers older ones', () => {
    const a = app({
      deployedVersion: 5,
      versions: [3, 4, 5]
        .map((n) => ({ version: n, image: `acme/site:${n}` }))
        .concat([{ version: 1, image: 'acme/site:1' }]),
    });
    const [v5, v4, v3, v1] = run(
      ['5', '4', '3', '1'].map((n) => img(`i${n}`, [`acme/site:${n}`])),
      [],
      [a],
      1,
    );
    expect(v5.kind).toBe('kept-version');
    expect(v4.kind).toBe('kept-version');
    expect(v3).toMatchObject({
      kind: 'old-version',
      delete: 'yes',
      app: 'site',
      version: 3,
    });
    expect(v1).toMatchObject({ kind: 'old-version', delete: 'yes' });
  });
  it('keeps nothing extra with keepVersions 0', () => {
    const a = app({
      deployedVersion: 5,
      versions: [4, 5].map((n) => ({ version: n, image: `s:${n}` })),
    });
    const [v5, v4] = run([img('a', ['s:5']), img('b', ['s:4'])], [], [a], 0);
    expect(v5.kind).toBe('kept-version');
    expect(v4.kind).toBe('old-version');
  });
  it('keeps an image if any app still keeps it', () => {
    const old = app({
      appName: 'a',
      deployedVersion: 9,
      versions: [{ version: 1, image: 'shared:1' }],
    });
    const fresh = app({
      appName: 'b',
      deployedVersion: 1,
      versions: [{ version: 1, image: 'shared:1' }],
    });
    expect(run([img('i', ['shared:1'])], [], [old, fresh])[0]).toMatchObject({
      kind: 'kept-version',
      app: 'b',
    });
  });
  it('needs an acknowledgement for images nothing here deployed', () => {
    expect(run([img('i', ['mysql:8'])])[0]).toMatchObject({
      kind: 'other-unused',
      delete: 'acknowledge',
    });
    expect(run([img('i', [])])[0].reason).toMatch(/untagged/);
  });
});

describe('helpers', () => {
  it('imageRepository drops the tag and digest but not a registry port', () => {
    expect(imageRepository('ghcr.io/org/app:1')).toBe('ghcr.io/org/app');
    expect(imageRepository('host:5000/app')).toBe('host:5000/app');
    expect(imageRepository('host:5000/app:2@sha256:abc')).toBe('host:5000/app');
    expect(imageRepository('nginx')).toBe('nginx');
  });
  it('summarizeReclaimable splits provable from needs-acknowledgement', () => {
    expect(
      summarizeReclaimable([
        { sizeBytes: 10, delete: 'yes' },
        { sizeBytes: 5, delete: 'acknowledge' },
        { sizeBytes: 100, delete: 'no' },
        { delete: 'yes' },
      ]),
    ).toEqual({ provable: 10, needsAck: 5 });
  });
});
