import { makeStack } from '../test-utils';

const ANON = 'e'.repeat(64);

async function setup() {
  const s = makeStack();
  await s.apps.create({ name: 'files', persistent: true });
  await s.apps.update('files', {
    volumes: [
      { containerPath: '/data', volumeName: 'data' },
      { containerPath: '/in', hostPath: '/srv/in', readOnly: true },
    ],
  });
  s.docker.host.volumes = [
    {
      name: 'pvx-files-data',
      labels: {},
      mountpoint: '/var/lib/docker/volumes/pvx-files-data/_data',
      sizeBytes: 1234,
    },
    {
      name: ANON,
      labels: {},
      mountpoint: `/var/lib/docker/volumes/${ANON}/_data`,
      sizeBytes: 55,
    },
  ];
  s.docker.mounts.set('pvx-files', [
    {
      type: 'volume',
      name: 'pvx-files-data',
      destination: '/data',
      readOnly: false,
    },
    { type: 'volume', name: ANON, destination: '/cache', readOnly: false },
  ]);
  return s;
}

describe('MountsService', () => {
  it('describes declared mounts with their Docker names and where they live', async () => {
    const s = await setup();
    const { mounts } = await s.mounts.get('files', false);
    expect(mounts[0]).toMatchObject({
      kind: 'volume',
      volumeName: 'data',
      dockerName: 'pvx-files-data',
      mode: 'rw',
      created: true,
      mountpoint: '/var/lib/docker/volumes/pvx-files-data/_data',
    });
    expect(mounts[1]).toEqual({
      containerPath: '/in',
      mode: 'ro',
      kind: 'bind',
      hostPath: '/srv/in',
    });
  });
  it('only measures sizes when asked', async () => {
    const s = await setup();
    expect(
      (await s.mounts.get('files', false)).mounts[0].sizeBytes,
    ).toBeUndefined();
    expect((await s.mounts.get('files', true)).mounts[0].sizeBytes).toBe(1234);
  });
  it('reports a volume that does not exist yet as not created', async () => {
    const s = await setup();
    s.docker.host.volumes = [];
    expect((await s.mounts.get('files', false)).mounts[0].created).toBe(false);
  });
  it('lists mounts the image created, not the declared ones', async () => {
    const s = await setup();
    const { detected } = await s.mounts.get('files', true);
    expect(detected).toEqual([
      {
        containerPath: '/cache',
        kind: 'volume',
        anonymous: true,
        volumeName: ANON,
        mountpoint: `/var/lib/docker/volumes/${ANON}/_data`,
        sizeBytes: 55,
      },
    ]);
  });
});
