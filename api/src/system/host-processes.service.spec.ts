import { ServiceUnavailableException } from '@nestjs/common';
import { FakeDocker } from '../docker/fake-docker';
import {
  FRESH_MS,
  HostProcessesService,
  ownerName,
  parseProcesses,
} from './host-processes.service';

const reading = (top: object[]) =>
  `noise\n${JSON.stringify({ dt: 1.01, top })}\n`;

describe('parseProcesses', () => {
  it('names the owner of a container process and leaves host processes without one', () => {
    const r = parseProcesses(
      reading([
        { n: 'node', c: 'abc123abc123', k: 2, u: 55.5, m: 300 },
        { n: 'dockerd', c: '', k: 1, u: 4, m: 900 },
      ]),
      { abc123abc123: 'pvx-worker' },
    );
    expect(r.byCpu[0]).toMatchObject({
      name: 'node',
      owner: 'worker',
      count: 2,
    });
    expect(r.byCpu[1].owner).toBeNull();
    expect(r.byMemory[0].name).toBe('dockerd');
    expect(r.sampledSeconds).toBe(1.01);
  });

  it('keeps ten of each', () => {
    const top = Array.from({ length: 25 }, (_, i) => ({
      n: `p${i}`,
      c: '',
      k: 1,
      u: i,
      m: i,
    }));
    const r = parseProcesses(reading(top), {});
    expect(r.byCpu).toHaveLength(10);
    expect(r.byCpu[0].name).toBe('p24');
  });

  it('refuses output with no reading', () => {
    expect(() => parseProcesses('Error: nope', {})).toThrow();
  });

  it('strips the platform prefix', () => {
    expect(ownerName('pvx-shop')).toBe('shop');
    expect(ownerName('redis')).toBe('redis');
  });
});

describe('HostProcessesService', () => {
  function make() {
    const docker = new FakeDocker();
    docker.helperResult = {
      exitCode: 0,
      output: reading([{ n: 'node', c: 'aaaaaaaaaaaa', k: 1, u: 10, m: 5 }]),
    };
    docker.owners = { aaaaaaaaaaaa: 'pvx-api' };
    docker.self = 'ghcr.io/provelox/provelox:0.3.3';
    return { docker, svc: new HostProcessesService(docker) };
  }

  it('runs a read-only helper that shares the host process view, and reuses a fresh reading', async () => {
    const { docker, svc } = make();
    const t = Date.now();
    const a = await svc.top(t);
    await svc.top(t + 1000);
    expect(docker.helperRuns).toHaveLength(1);
    expect(docker.helperRuns[0]).toMatchObject({
      hostPid: true,
      entrypoint: ['node'],
      mounts: [],
    });
    expect(a.byCpu[0].owner).toBe('api');
    // well past the freshness window, whatever time the fake helper took on a slow machine (the service stamps a
    // reading with the real clock when it finishes, not with the time the test passed in)
    await svc.top(t + FRESH_MS + 5_000);
    expect(docker.helperRuns).toHaveLength(2);
  });

  it('answers 503 when the helper fails', async () => {
    const { docker, svc } = make();
    docker.helperResult = { exitCode: 1, output: 'boom' };
    await expect(svc.top()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
