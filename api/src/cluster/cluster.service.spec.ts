import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';
import type { NodeInfo } from '../docker/docker.port';
import { ClusterService } from './cluster.service';

const node = (id: string, o: Partial<NodeInfo> = {}): NodeInfo => ({
  id,
  hostname: `host-${id}`,
  role: 'worker',
  state: 'ready',
  availability: 'active',
  address: `10.0.0.${id.length}`,
  cpus: 4,
  memoryBytes: 8e9,
  os: 'linux',
  architecture: 'x86_64',
  dockerVersion: '27',
  ...o,
});

function setup(nodes: NodeInfo[]) {
  const { docker, apps } = makeStack();
  docker.nodes = nodes;
  return { docker, apps, cluster: new ClusterService(docker, apps) };
}

describe('ClusterService.overview', () => {
  it('lists the machines with what runs on each', async () => {
    const { docker, cluster } = setup([
      node('a', { role: 'leader' }),
      node('b'),
    ]);
    for (const s of ['pvx-provelox', 'pvx-blog', 'pvx-shop'])
      docker.services.set(s, { Name: s } as never);
    docker.taskNodes.set('pvx-shop', 'b');
    const o = await cluster.overview();
    expect(o.nodes.map((n) => [n.hostname, n.isLocal])).toEqual([
      ['host-a', true],
      ['host-b', false],
    ]);
    expect(o.nodes[0].workloads).toEqual([
      { name: 'API', kind: 'platform', count: 1 },
      { name: 'blog', kind: 'app', count: 1 },
    ]);
    expect(o.nodes[1].workloads).toEqual([
      { name: 'shop', kind: 'app', count: 1 },
    ]);
    expect(o.managers).toBe(1);
    expect(o.canJoin).toBe(true);
  });

  it('warns about an even number of managers and a machine that is down', async () => {
    const { cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { role: 'manager' }),
      node('c', { state: 'down' }),
    ]);
    const w = (await cluster.overview()).warnings.join('\n');
    expect(w).toMatch(/two managers/);
    expect(w).toMatch(/host-c is down/);
  });

  it('cannot take joins when this host is not a manager', async () => {
    const { docker, cluster } = setup([]);
    docker.swarm = 'none';
    expect((await cluster.overview()).canJoin).toBe(false);
    await expect(cluster.joinInstructions()).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('ClusterService.joinInstructions', () => {
  it('gives each role its token and both commands', async () => {
    const { docker, cluster } = setup([node('a', { role: 'leader' })]);
    docker.services.set('pvx-provelox', {
      Name: 'pvx-provelox',
      Labels: {},
      Mode: { Replicated: { Replicas: 1 } },
      TaskTemplate: { ContainerSpec: { Image: 'reg.io/provelox:0.2.23' } },
    } as never);
    const j = await cluster.joinInstructions();
    expect(j.managerAddress).toBe('10.0.0.1:2377');
    expect(j.worker.swarmCommand).toBe(
      'docker swarm join --token SWMTKN-1-worker-token 10.0.0.1:2377',
    );
    expect(j.manager.proveloxCommand).toContain(
      'reg.io/provelox:0.2.23 join --token SWMTKN-1-manager-token --manager 10.0.0.1:2377',
    );
    expect(j.ports).toContain('2377/tcp');
  });

  it('rotates one role and returns the new tokens', async () => {
    const { docker, cluster } = setup([node('a', { role: 'leader' })]);
    const before = (await cluster.joinInstructions()).worker.token;
    const after = await cluster.rotateToken('worker');
    expect(after.worker.token).not.toBe(before);
    expect(after.manager.token).toBe('SWMTKN-1-manager-token');
    expect(docker.calls).toContain('rotate:worker');
    await expect(cluster.rotateToken('root')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('ClusterService.setAvailability', () => {
  it('drains and activates a worker', async () => {
    const { docker, cluster } = setup([
      node('a', { role: 'leader' }),
      node('b'),
    ]);
    await cluster.setAvailability('b', 'drain');
    expect(docker.nodes[1].availability).toBe('drain');
    await cluster.setAvailability('b', 'active');
    expect(docker.nodes[1].availability).toBe('active');
  });

  it('will not drain the only manager that can take work', async () => {
    const { cluster } = setup([node('a', { role: 'leader' }), node('b')]);
    await expect(cluster.setAvailability('a', 'drain')).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('drains a manager when another can take over', async () => {
    const { docker, cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { role: 'manager' }),
    ]);
    await cluster.setAvailability('a', 'drain');
    expect(docker.nodes[0].availability).toBe('drain');
  });

  it('rejects an unknown machine or setting', async () => {
    const { cluster } = setup([node('a', { role: 'leader' })]);
    await expect(cluster.setAvailability('zz', 'drain')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(cluster.setAvailability('a', 'sleep')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('ClusterService.setRole', () => {
  it('promotes a reachable worker and demotes a manager that is not this one', async () => {
    const { docker, cluster } = setup([
      node('a', { role: 'leader' }),
      node('b'),
      node('c', { role: 'manager' }),
    ]);
    await cluster.setRole('b', 'manager');
    expect(docker.nodes[1].role).toBe('manager');
    await cluster.setRole('c', 'worker');
    expect(docker.nodes[2].role).toBe('worker');
  });

  it('will not promote a machine that is down', async () => {
    const { cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { state: 'down' }),
    ]);
    await expect(cluster.setRole('b', 'manager')).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('will not demote the machine the API talks to, nor the last manager', async () => {
    const { cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { role: 'manager' }),
    ]);
    await expect(cluster.setRole('a', 'worker')).rejects.toThrow(
      /API talks to/,
    );
    const single = setup([node('a', { role: 'leader' })]);
    // not local either, to reach the last-manager rule
    single.docker.swarm = 'manager';
    single.docker.nodes = [node('x', { role: 'leader' })];
    single.docker.nodes.unshift(node('local', { role: 'worker' }));
    await expect(single.cluster.setRole('x', 'worker')).rejects.toThrow(
      /only manager/,
    );
  });
});

describe('ClusterService.remove', () => {
  it('removes a worker that has left, which shows as down', async () => {
    const { docker, cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { state: 'down', availability: 'drain' }),
    ]);
    await cluster.remove('b');
    expect(docker.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('asks a worker that is still in the cluster to leave first', async () => {
    const { cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { availability: 'drain' }),
    ]);
    await expect(cluster.remove('b')).rejects.toThrow(/swarm leave/);
  });

  it('refuses a manager, and the machine the API talks to', async () => {
    const { cluster } = setup([
      node('a', { role: 'leader' }),
      node('c', { role: 'manager' }),
    ]);
    await expect(cluster.remove('c')).rejects.toThrow(/Demote it/);
    await expect(cluster.remove('a')).rejects.toThrow(/API talks to/);
  });

  it('will not strand the data of an app held to the machine, until it is released', async () => {
    const { cluster, apps, docker } = setup([
      node('a', { role: 'leader' }),
      node('b'),
    ]);
    docker.taskNodes.set('pvx-db', 'b');
    await apps.create({ name: 'db', persistent: true });
    await apps.update('db', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    docker.nodes[1].state = 'down';
    await expect(cluster.remove('b')).rejects.toThrow(/keeps data|keep data/);
    apps.releasePin('db');
    await cluster.remove('b');
    expect(docker.nodes).toHaveLength(1);
  });
});

describe('ClusterService safety when Docker does not answer', () => {
  it('does not treat an unknown local machine as safe to demote', async () => {
    const { docker, cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { role: 'manager' }),
    ]);
    docker.swarm = 'none'; // the fake then has no local machine id
    await expect(cluster.setRole('b', 'worker')).rejects.toThrow(
      /did not say which machine/,
    );
  });

  it('does not count a manager that is down as one that can take over', async () => {
    const { cluster } = setup([
      node('a', { role: 'leader' }),
      node('b', { role: 'manager', state: 'down' }),
      node('c', { role: 'manager' }),
    ]);
    // c is the only other manager that is up, so demoting a (not local here, c is) is allowed; demoting c leaves a only
    await expect(cluster.setRole('c', 'worker')).resolves.toBeUndefined();
    const only = setup([
      node('x'),
      node('y', { role: 'manager' }),
      node('z', { role: 'manager', state: 'down' }),
    ]);
    await expect(only.cluster.setRole('y', 'worker')).rejects.toThrow(
      /only manager that is up/,
    );
  });

  it('will not pause the only manager that can take work', async () => {
    const { cluster } = setup([node('a', { role: 'leader' }), node('b')]);
    await expect(cluster.setAvailability('a', 'pause')).rejects.toThrow(
      /only manager/,
    );
  });
});

describe('ClusterService pins', () => {
  it('pins apps with local data as soon as the cluster has two machines, and says which are held', async () => {
    const { cluster, apps, docker } = setup([node('a', { role: 'leader' })]);
    await apps.create({ name: 'db', persistent: true });
    await apps.update('db', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    expect(await apps.pinnedTo('db')).toBeNull(); // one machine: nothing to hold it to
    docker.nodes = [node('a', { role: 'leader' }), node('b')];
    const o = await cluster.overview();
    expect(await apps.pinnedTo('db')).toBe('host-a');
    expect(o.nodes[0].workloads.find((w) => w.name === 'db')?.pinned).toBe(
      true,
    );
  });

  it('warns about an app whose data it cannot place, instead of guessing', async () => {
    const { cluster, apps, docker } = setup([
      node('a', { role: 'leader' }),
      node('b'),
    ]);
    await apps.create({ name: 'db', persistent: true });
    // volumes arrive while the cluster is still one machine, so no pin was made
    docker.nodes = [node('a', { role: 'leader' })];
    await apps.update('db', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    // the machine it last ran on has since left
    docker.taskNodes.set('pvx-db', 'gone');
    docker.nodes = [node('a', { role: 'leader' }), node('b')];
    const w = (await cluster.overview()).warnings.join('\n');
    expect(w).toMatch(/db: .*no longer in the cluster/);
    expect(await apps.pinnedTo('db')).toBeNull();
  });
});

describe('ClusterService network encryption', () => {
  it('gives the fix once there is more than one machine and the network is plain, and not before', async () => {
    const two = setup([node('a', { role: 'leader' }), node('b')]);
    two.docker.plainNetworks = ['provelox-net'];
    two.docker.services.set('pvx-provelox', {
      Name: 'pvx-provelox',
      Labels: {},
      Mode: { Replicated: { Replicas: 1 } },
      TaskTemplate: { ContainerSpec: { Image: 'reg.io/provelox:0.2.23' } },
    } as never);
    const o = await two.cluster.overview();
    expect(o.encryptCommand).toBe(
      'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock reg.io/provelox:0.2.23 encrypt-network',
    );
    const one = setup([node('a', { role: 'leader' })]);
    one.docker.plainNetworks = ['provelox-net'];
    expect((await one.cluster.overview()).encryptCommand).toBeNull();
    const fine = setup([node('a', { role: 'leader' }), node('b')]);
    expect((await fine.cluster.overview()).encryptCommand).toBeNull();
  });
});
