import { caproverRuntime, isCaproverService, orderServices } from './runtime';

describe('CapRover runtime', () => {
  const services = [
    { name: 'captain-captain', replicas: 1 },
    { name: 'srv-captain--web', replicas: 1 },
    { name: 'captain-nginx', replicas: 0 },
    { name: 'pvx-web', replicas: 1 },
    { name: 'pvx-traefik', replicas: 1 },
    { name: 'captainhook', replicas: 1 },
    { name: 'srv-captain--old', replicas: 0 },
  ];

  it('only ever names CapRover services, apps first and the dashboard last', () => {
    expect(orderServices(services).map((s) => s.name)).toEqual([
      'srv-captain--old',
      'srv-captain--web',
      'captain-nginx',
      'captain-captain',
    ]);
    expect(isCaproverService('pvx-web')).toBe(false);
    expect(isCaproverService('captainhook')).toBe(false);
  });
});

describe('stopping an app that has no CapRover service', () => {
  const runtime = (inspect: () => Promise<unknown>) =>
    caproverRuntime({
      docker: { getService: () => ({ inspect }) },
      backupDir: '/nonexistent-backup-dir',
    } as never);

  it('treats "no such service" as already stopped, with nothing to restore', async () => {
    const missing = Object.assign(new Error('no such service'), {
      statusCode: 404,
    });
    const stopped = await runtime(() => Promise.reject(missing)).stopApp(
      'accounting',
    );
    await expect(stopped.restore()).resolves.toBeUndefined();
  });

  it('still fails on any other error, so a real problem is not hidden', async () => {
    const down = Object.assign(new Error('boom'), { statusCode: 500 });
    await expect(
      runtime(() => Promise.reject(down)).stopApp('accounting'),
    ).rejects.toThrow('boom');
  });
});
