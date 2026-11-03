import { Logger } from '@nestjs/common';
import { ConflictError } from '../common/errors';
import { serviceName } from '../common/naming';
import type { DockerPort } from '../docker/docker.port';
import type { AppsService } from './apps.service';

/**
 * Runs `work` with the app stopped, and starts it again with the number of instances it had however `work` ends: done,
 * failed, or cancelled. If the app cannot be stopped in time it is started again at once and `work` never runs.
 * An app that is not running is left alone (and stays stopped). The same rule as stopping for a download or a restore,
 * kept in one place for what is new.
 */
export async function withAppStopped<T>(
  deps: {
    apps: AppsService;
    docker: DockerPort;
    log: Logger;
    waitMs: number;
    pollMs: number;
  },
  appName: string,
  instances: number,
  /** What to tell when it did not stop in time: what did not happen, such as "nothing was written" */
  untouched: string,
  work: () => Promise<T>,
): Promise<{ value: T; stopped: boolean }> {
  const { apps, docker, log } = deps;
  const stop = instances > 0;
  if (!stop) return { value: await work(), stopped: false };

  let putBack: Promise<void> | null = null;
  const restore = () =>
    (putBack ??= (async () => {
      try {
        await apps.mutate(
          appName,
          async (cur) => ({ ...cur, instanceCount: instances }),
          { duringMigration: true },
        );
      } finally {
        apps.unblock(appName);
      }
    })());
  const restoreLogged = (when: string) =>
    restore().catch((err) =>
      log.error(
        `Could not start ${appName} again ${when}: ${err instanceof Error ? err.message : err}`,
      ),
    );

  apps.block(appName);
  try {
    await apps.mutate(appName, async (cur) => ({ ...cur, instanceCount: 0 }), {
      duringMigration: true,
    });
    const end = Date.now() + deps.waitMs;
    while ((await docker.countContainers(serviceName(appName))) > 0) {
      if (Date.now() > end)
        throw new ConflictError(
          `"${appName}" did not stop within ${Math.round(deps.waitMs / 1000)} seconds. It was started again; ${untouched}.`,
        );
      await new Promise((r) => setTimeout(r, deps.pollMs));
    }
  } catch (e) {
    await restoreLogged('after a failed stop');
    throw e;
  }
  try {
    return { value: await work(), stopped: true };
  } finally {
    await restoreLogged('after the work');
  }
}
