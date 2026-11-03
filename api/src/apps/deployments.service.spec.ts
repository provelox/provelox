import { DeploymentsService } from './deployments.service';
import { FakeDocker } from '../docker/fake-docker';
import type { ServiceStatus } from '../docker/docker.port';

const state = () => ({
  app: 'site',
  version: 2,
  image: 'x:1',
  isBuilding: true,
  isFailed: false,
  lines: ['Deploying'],
  startedAt: '',
});

function setup(status: ServiceStatus | null) {
  const docker = new FakeDocker();
  docker.statusOverride = () => status;
  return new DeploymentsService(docker);
}

describe('DeploymentsService.step', () => {
  it('finishes successfully when the service is running', async () => {
    const d = setup({ desired: 2, running: 2, state: 'running' });
    const s = state();
    expect(await d.step(s)).toBe(true);
    expect(s).toMatchObject({ isBuilding: false, isFailed: false });
    expect(s.lines.at(-1)).toBe('Running: 2/2 instances.');
  });
  it('keeps waiting while tasks are starting, without repeating itself', async () => {
    const d = setup({ desired: 1, running: 0, state: 'starting' });
    const s = state();
    expect(await d.step(s)).toBe(false);
    expect(await d.step(s)).toBe(false);
    expect(s.lines.filter((l) => l.startsWith('Starting'))).toHaveLength(1);
    expect(s.isBuilding).toBe(true);
  });
  it('waits while Docker is still updating, even if the old task runs', async () => {
    const d = setup({
      desired: 1,
      running: 1,
      state: 'running',
      updateState: 'updating',
    });
    expect(await d.step(state())).toBe(false);
  });
  it("fails when containers keep dying, with Docker's reason", async () => {
    const d = setup({
      desired: 1,
      running: 0,
      state: 'failed',
      message: 'exec format error',
    });
    const s = state();
    expect(await d.step(s)).toBe(true);
    expect(s.isFailed).toBe(true);
    expect(s.lines.at(-1)).toContain('exec format error');
  });
  it('fails when Docker rolled the update back', async () => {
    const d = setup({
      desired: 1,
      running: 1,
      state: 'running',
      updateState: 'rollback_completed',
    });
    const s = state();
    expect(await d.step(s)).toBe(true);
    expect(s.isFailed).toBe(true);
  });
  it('says why an update was rolled back, and what to do about a missing platform', async () => {
    const d = setup({
      desired: 1,
      running: 1,
      state: 'running',
      updateState: 'rollback_completed',
      message:
        'no matching manifest for linux/arm64/v8 in the manifest list entries',
    });
    const s = state();
    await d.step(s);
    expect(s.lines.join('\n')).toContain(
      'no matching manifest for linux/arm64/v8',
    );
    expect(s.lines.at(-1)).toContain('not built for this server');
  });
  it('fails when the service vanished', async () => {
    const s = state();
    expect(await setup(null).step(s)).toBe(true);
    expect(s.isFailed).toBe(true);
  });
  it('gives up after the deadline', async () => {
    const d = setup({ desired: 1, running: 0, state: 'starting' });
    const s = state();
    expect(await d.step(s, true)).toBe(true);
    expect(s).toMatchObject({ isBuilding: false, isFailed: true });
  });
  it('treats scaled-to-zero as a successful deploy', async () => {
    const s = state();
    expect(
      await setup({ desired: 0, running: 0, state: 'stopped' }).step(s),
    ).toBe(true);
    expect(s.isFailed).toBe(false);
  });
});

describe('DeploymentsService.track', () => {
  it('records the outcome', async () => {
    const d = setup({ desired: 1, running: 1, state: 'running' });
    d.track('site', 3, 'x:3', { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(d.get('site')).toMatchObject({
      version: 3,
      isBuilding: false,
      isFailed: false,
    });
    d.onModuleDestroy();
  });
  it('is null for apps never deployed here', () => {
    expect(setup(null).get('nope')).toBeNull();
  });
});
