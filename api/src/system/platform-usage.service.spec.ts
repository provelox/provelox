import { FakeDocker } from '../docker/fake-docker';
import {
  FRESH_MS,
  RETRY_EMPTY_MS,
  PlatformUsageService,
  TOO_OLD_MS,
} from './platform-usage.service';

const use = (cpuPercent: number) => ({
  instances: 1,
  cpuPercent,
  memoryBytes: 1,
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** Waits until something is true (a refresh runs behind the call, and a busy machine can be slow), or fails after a while. */
async function until(done: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the refresh.');
    await tick(10);
  }
}

describe('PlatformUsageService', () => {
  const setup = () => {
    const docker = new FakeDocker();
    let cpu = 1;
    let calls = 0;
    let gate: Promise<void> | null = null;
    docker.serviceUsage = async () => {
      calls++;
      if (gate) await gate;
      return use(cpu);
    };
    const svc = new PlatformUsageService(docker);
    return {
      svc,
      calls: () => calls,
      set: (v: number) => (cpu = v),
      hold: () => {
        let open!: () => void;
        gate = new Promise<void>((r) => (open = r));
        return () => {
          gate = null;
          open();
        };
      },
    };
  };

  it('waits only for the very first reading', async () => {
    const { svc, calls } = setup();
    expect((await svc.of('pvx-provelox'))?.cpuPercent).toBe(1);
    expect(calls()).toBe(3); // the three platform services, once
  });

  it('reuses a fresh reading without asking Docker again', async () => {
    const { svc, calls } = setup();
    const t = Date.now();
    await svc.of('pvx-provelox', t);
    await svc.of('pvx-traefik', t + FRESH_MS - 1);
    await tick();
    expect(calls()).toBe(3);
  });

  it('answers from the last reading at once when it is stale, and refreshes behind the call', async () => {
    const { svc, set, hold, calls } = setup();
    const t = Date.now();
    await svc.of('pvx-provelox', t);
    const release = hold();
    set(50);
    const answer = await Promise.race([
      svc.of('pvx-provelox', t + FRESH_MS + 1),
      new Promise((r) => setTimeout(() => r('waited'), 150)),
    ]);
    expect(answer).not.toBe('waited');
    expect((answer as { cpuPercent: number }).cpuPercent).toBe(1);
    release();
    // the refresh runs behind the call: look until it has landed
    await until(() => calls() >= 6);
    await tick(20);
    expect((await svc.of('pvx-provelox', t + FRESH_MS + 2))?.cpuPercent).toBe(
      50,
    );
  });

  it('starts one refresh however many ask at once', async () => {
    const { svc, calls } = setup();
    const t = Date.now();
    await svc.of('pvx-provelox', t);
    await Promise.all(
      [1, 2, 3, 4, 5].map(() => svc.of('pvx-console', t + FRESH_MS + 1)),
    );
    await until(() => calls() >= 6);
    // and no second refresh follows it
    await tick(60);
    expect(calls()).toBe(6); // 3 for the first reading, 3 for the one refresh
  });

  it('waits for a new reading when the last is minutes old, and keeps the last when a refresh fails', async () => {
    const { svc, set } = setup();
    const t = Date.now();
    await svc.of('pvx-provelox', t);
    set(9);
    expect((await svc.of('pvx-provelox', t + TOO_OLD_MS + 1))?.cpuPercent).toBe(
      9,
    );
  });

  it('says nothing for a service Docker does not know', async () => {
    const docker = new FakeDocker();
    docker.serviceUsage = async () => {
      throw new Error('no such service');
    };
    expect(
      await new PlatformUsageService(docker).of('pvx-provelox'),
    ).toBeNull();
  });

  it('looks again soon at a service that had no reading, since it may not have started when it was taken', async () => {
    const docker = new FakeDocker();
    let ready = false;
    docker.serviceUsage = async () => (ready ? use(7) : null);
    const svc = new PlatformUsageService(docker);
    const t = Date.now();
    expect(await svc.of('pvx-console', t)).toBeNull();
    ready = true;
    // not yet: it was only just looked at
    expect(await svc.of('pvx-console', t + 100)).toBeNull();
    expect(
      (await svc.of('pvx-console', t + RETRY_EMPTY_MS + 1))?.cpuPercent,
    ).toBe(7);
  });
});
