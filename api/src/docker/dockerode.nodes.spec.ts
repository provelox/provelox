import { DockerodeAdapter } from './dockerode.adapter';

const adapter = (nodes: unknown) =>
  Object.assign(Object.create(DockerodeAdapter.prototype), {
    docker: { listNodes: async () => nodes },
  }) as DockerodeAdapter;

describe('DockerodeAdapter.listNodes', () => {
  it('reduces Docker nodes to what the console shows', async () => {
    const [n] = await adapter([
      {
        ID: 'abc',
        Spec: { Availability: 'drain', Labels: { secret: 'x' } },
        Description: {
          Hostname: 'host-1',
          Platform: { OS: 'linux', Architecture: 'x86_64' },
          Resources: { NanoCPUs: 8_000_000_000, MemoryBytes: 33_653_977_088 },
          Engine: { EngineVersion: '28.1.1', Plugins: [] },
        },
        Status: { State: 'ready', Addr: '208.87.134.134' },
        ManagerStatus: { Leader: true, Reachability: 'reachable' },
      },
    ]).listNodes();
    expect(n).toEqual({
      id: 'abc',
      hostname: 'host-1',
      role: 'leader',
      state: 'ready',
      availability: 'drain',
      address: '208.87.134.134',
      cpus: 8,
      memoryBytes: 33_653_977_088,
      os: 'linux',
      architecture: 'x86_64',
      dockerVersion: '28.1.1',
    });
  });
  it('names the operating system for the machine the API talks to, and only that one', async () => {
    const a = Object.assign(Object.create(DockerodeAdapter.prototype), {
      docker: {
        listNodes: async () => [{ ID: 'me' }, { ID: 'other' }],
        info: async () => ({
          OperatingSystem: 'Ubuntu 24.04.1 LTS',
          KernelVersion: '6.8.0-45-generic',
          Swarm: { NodeID: 'me' },
        }),
      },
    }) as DockerodeAdapter;
    const [me, other] = await a.listNodes();
    expect(me).toMatchObject({
      osName: 'Ubuntu 24.04.1 LTS',
      kernel: '6.8.0-45-generic',
    });
    expect(other.osName).toBeUndefined();
    expect(other.kernel).toBeUndefined();
  });
  it('still lists the nodes when Docker will not say what it runs on', async () => {
    const a = Object.assign(Object.create(DockerodeAdapter.prototype), {
      docker: {
        listNodes: async () => [{ ID: 'me' }],
        info: async () => {
          throw new Error('no');
        },
      },
    }) as DockerodeAdapter;
    const [n] = await a.listNodes();
    expect(n.id).toBe('me');
    expect(n.osName).toBeUndefined();
  });
  it('tells managers from workers', async () => {
    const roles = (
      await adapter([
        { ID: 'a', ManagerStatus: { Leader: false } },
        { ID: 'b' },
      ]).listNodes()
    ).map((x) => x.role);
    expect(roles).toEqual(['manager', 'worker']);
  });
  it('falls back to safe values for a node Docker describes oddly', async () => {
    const [n] = await adapter([
      { ID: 'x', Status: { State: 'weird' }, Spec: { Availability: 'odd' } },
    ]).listNodes();
    expect(n).toMatchObject({
      state: 'unknown',
      availability: 'active',
      hostname: '',
      cpus: 0,
      memoryBytes: 0,
    });
  });
  it('is empty when this host is not a Swarm manager', async () => {
    const a = Object.assign(Object.create(DockerodeAdapter.prototype), {
      docker: {
        listNodes: async () => {
          throw new Error('This node is not a swarm manager');
        },
      },
    }) as DockerodeAdapter;
    expect(await a.listNodes()).toEqual([]);
  });
});
