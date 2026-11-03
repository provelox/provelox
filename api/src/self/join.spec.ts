import { ValidationError } from '../common/errors';
import { FakeDocker } from '../docker/fake-docker';
import { joinCluster, parseManager } from './join';

const TOKEN = 'SWMTKN-1-abc123-def456';

describe('parseManager', () => {
  it('reads host:port, including an IPv6 address', () => {
    expect(parseManager('10.0.0.1:2377')).toEqual({
      host: '10.0.0.1',
      port: 2377,
    });
    expect(parseManager('mgr.example.com:2377').host).toBe('mgr.example.com');
    expect(parseManager('[2001:db8::1]:2377')).toEqual({
      host: '2001:db8::1',
      port: 2377,
    });
  });
  it('rejects anything else', () => {
    for (const bad of ['10.0.0.1', 'host:0', 'host:70000', 'a b:2377', ''])
      expect(() => parseManager(bad)).toThrow(ValidationError);
  });
});

describe('joinCluster', () => {
  const free = () => {
    const docker = new FakeDocker();
    docker.swarm = 'none';
    return docker;
  };

  it('looks at the manager, then joins', async () => {
    const docker = free();
    const seen: string[] = [];
    const r = await joinCluster(
      docker,
      { token: TOKEN, manager: '10.0.0.1:2377' },
      async (h, p) => (seen.push(`${h}:${p}`), true),
    );
    expect(seen).toEqual(['10.0.0.1:2377']);
    expect(docker.calls).toContain('join:10.0.0.1:2377');
    expect(r.manager).toBe('10.0.0.1:2377');
  });

  it('explains a manager it cannot reach, without joining', async () => {
    const docker = free();
    await expect(
      joinCluster(
        docker,
        { token: TOKEN, manager: '10.0.0.1:2377' },
        async () => false,
      ),
    ).rejects.toThrow(/2377\/tcp/);
    expect(docker.calls.some((c) => c.startsWith('join:'))).toBe(false);
  });

  it('refuses a machine that is already in a Swarm, and something that is not a token', async () => {
    const inSwarm = new FakeDocker();
    await expect(
      joinCluster(
        inSwarm,
        { token: TOKEN, manager: '10.0.0.1:2377' },
        async () => true,
      ),
    ).rejects.toThrow(/already part of a Swarm/);
    await expect(
      joinCluster(
        free(),
        { token: 'hunter2', manager: '10.0.0.1:2377' },
        async () => true,
      ),
    ).rejects.toThrow(/join token/);
  });
});
