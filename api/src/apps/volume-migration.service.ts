import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import {
  LABEL_APP,
  LABEL_PROJECT,
  serviceName,
  volumeName,
} from '../common/naming';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import type { AppDefinition } from './app.model';
import { AppsService } from './apps.service';
import { volumeOwner } from './service-spec';

export const MIGRATED_FROM_LABEL = 'io.provelox.migrated-from';
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface DetectedMount {
  containerPath: string;
  /** The Docker volume currently mounted there */
  volume: string;
  /** The image created it itself (a VOLUME line in its Dockerfile): it is new and empty on every redeploy */
  anonymous: boolean;
}

export interface MigrationState {
  app: string;
  containerPath: string;
  volumeName: string;
  from: string;
  status: 'running' | 'done' | 'failed';
  log: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /**
   * Set when a move failed after the app was stopped: the original volume is still held by a helper container, so
   * Docker cannot delete it along with the old container. Release it with `releaseHold` once it is not needed.
   */
  heldVolume?: string;
}

/**
 * Moves data an image keeps in an unnamed volume into a named, managed one, so it survives redeploys.
 *
 * Why it is careful: Docker deletes an unnamed volume together with the container that created it, and Swarm removes
 * stopped containers on its own schedule. So the original is held by an idle helper container for the whole move.
 * It is only read, never written. If the move fails the app is restored, the half-made new volume removed, and the
 * hold is KEPT: the app has been restored onto a fresh volume, so the original may be the only copy of the data.
 * While a move runs nothing else may change the app.
 */
@Injectable()
export class VolumeMigrationService {
  private readonly log = new Logger('VolumeMigration');
  private readonly states = new Map<string, MigrationState>();
  /** How long to wait for the app to stop or start. Public so tests need not wait. */
  waitTimeoutMs = 120_000;
  pollMs = 1000;

  constructor(
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  get(app: string): MigrationState | null {
    return this.states.get(app) ?? null;
  }

  /** Lets go of a volume held after a failed move. Only then can Docker (or Storage) remove it. */
  async releaseHold(appName: string): Promise<{ released: number }> {
    this.apps.getDefinition(appName);
    if (this.states.get(appName)?.status === 'running')
      throw new ConflictError(
        'A move is running for this app: wait for it to finish.',
      );
    const released = await this.docker.releasePins(appName);
    const st = this.states.get(appName);
    if (st?.heldVolume) {
      st.heldVolume = undefined;
      st.log.push('The hold on the original volume was released.');
    }
    return { released };
  }

  /** Mounts the running app has that Provelox does not manage. */
  async detect(appName: string): Promise<DetectedMount[]> {
    const app = this.apps.getDefinition(appName);
    const declaredPaths = new Set(
      app.volumes.map((v) => v.containerPath.replace(/\/+$/, '')),
    );
    return (await this.docker.serviceMounts(serviceName(appName)))
      .filter(
        (m) =>
          m.type === 'volume' &&
          m.name &&
          !declaredPaths.has(m.destination.replace(/\/+$/, '')),
      )
      .map((m) => ({
        containerPath: m.destination,
        volume: m.name as string,
        anonymous: /^[0-9a-f]{64}$/.test(m.name as string),
      }));
  }

  /** Checks everything that can be checked up front, then runs the move in the background. */
  async start(
    appName: string,
    containerPath: string,
    rawName: string,
  ): Promise<MigrationState> {
    const app = this.apps.getDefinition(appName);
    if (
      this.apps.isBlocked(appName) ||
      this.states.get(appName)?.status === 'running'
    )
      throw new ConflictError('A move is already running for this app.');
    if (!app.persistent)
      throw new ValidationError(
        'Only apps created with persistent data can have their data moved into a volume.',
      );
    if (!VOLUME_NAME.test(rawName))
      throw new ValidationError(
        'Volume names use letters, numbers, dots, dashes and underscores.',
      );
    if (app.volumes.some((v) => v.volumeName === rawName))
      throw new ConflictError(
        `The app already has a volume named "${rawName}".`,
      );

    const found = (await this.detect(appName)).find(
      (d) =>
        d.containerPath.replace(/\/+$/, '') ===
        containerPath.replace(/\/+$/, ''),
    );
    if (!found)
      throw new NotFoundError(
        `The running app has no unmanaged volume at ${containerPath}. It must be running to be moved.`,
      );
    const target = volumeName(volumeOwner(app), rawName);
    if (await this.docker.volumeExists(target))
      throw new ConflictError(
        `A Docker volume named "${target}" already exists. Choose another name.`,
      );

    const state: MigrationState = {
      app: appName,
      containerPath: found.containerPath,
      volumeName: rawName,
      from: found.volume,
      status: 'running',
      log: [
        `Moving ${found.containerPath} (volume ${found.volume.slice(0, 12)}…) into ${target}`,
      ],
      startedAt: new Date().toISOString(),
    };
    this.states.set(appName, state);
    this.apps.block(appName);
    void this.run(app, state, target);
    return state;
  }

  private async waitFor(what: string, done: () => Promise<boolean>) {
    const end = Date.now() + this.waitTimeoutMs;
    while (!(await done())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  private async run(
    before: AppDefinition,
    state: MigrationState,
    target: string,
  ) {
    const say = (line: string) => state.log.push(line);
    const service = serviceName(before.name);
    let createdVolume = false;
    let stopped = false;
    let pin: string | undefined;
    try {
      say(
        'Holding the original volume so Docker cannot remove it while the app stops',
      );
      pin = await this.docker.pinVolume(
        state.from,
        this.cfg.HELPER_IMAGE,
        before.name,
      );

      say('Stopping the app so nothing writes while the data is copied');
      await this.apps.mutate(
        before.name,
        async (cur) => ({ ...cur, instanceCount: 0 }),
        {
          duringMigration: true,
        },
      );
      stopped = true;
      await this.waitFor(
        'the app to stop',
        async () => (await this.docker.countContainers(service)) === 0,
      );

      say(`Creating the volume ${target}`);
      await this.docker.createVolume(target, {
        [before.project ? LABEL_PROJECT : LABEL_APP]:
          before.project ?? before.name,
        [LABEL_APP]: before.name,
        [MIGRATED_FROM_LABEL]: state.from,
      });
      createdVolume = true;

      say('Copying and verifying the data (the original is only read)');
      const r = await this.docker.runHelper({
        image: this.cfg.HELPER_IMAGE,
        // cp keeps permissions, ownership and links; diff -r proves the copy matches
        command: ['sh', '-c', 'cp -a /from/. /to/ && diff -r /from /to'],
        mounts: [
          { volume: state.from, target: '/from', readOnly: true },
          { volume: target, target: '/to', readOnly: false },
        ],
      });
      if (r.exitCode !== 0)
        throw new Error(
          `The copy did not verify (exit ${r.exitCode}). ${r.output.trim().slice(-300)}`,
        );

      say('Switching the app to the new volume and starting it');
      await this.apps.mutate(
        before.name,
        async (cur) => ({
          ...cur,
          instanceCount: before.instanceCount,
          volumes: [
            ...cur.volumes,
            {
              containerPath: state.containerPath,
              volumeName: state.volumeName,
              readOnly: false,
            },
          ],
        }),
        { duringMigration: true },
      );
      await this.waitFor(
        'the app to start',
        async () =>
          (await this.docker.serviceStatus(service))?.state === 'running',
      );

      state.status = 'done';
      say(
        'Done. The data now lives in the named volume and survives redeploys.',
      );
      // The copy is verified and the app runs on the new volume: the original is no longer needed. Docker removes it
      // together with the old container.
      await this.docker
        .releasePin(pin)
        .catch(() =>
          say(
            'The helper container holding the original could not be removed: it is labelled io.provelox.helper.',
          ),
        );
      pin = undefined;
    } catch (e) {
      state.status = 'failed';
      state.error = e instanceof Error ? e.message : 'The move failed.';
      say(`Failed: ${state.error}`);
      await this.rollback(before, state, target, { createdVolume, stopped });
      if (pin) {
        // The app was restored onto a fresh volume, so the original may hold the only copy. Keep holding it.
        state.heldVolume = state.from;
        say(
          `Your original data is safe in the volume ${state.from.slice(0, 12)}…, held by a helper container. ` +
            'Nothing will delete it. Release the hold when you no longer need it.',
        );
      }
    } finally {
      state.finishedAt = new Date().toISOString();
      this.apps.unblock(before.name);
    }
  }

  /** Puts the app back exactly as it was and removes the new volume if this move created it. */
  private async rollback(
    before: AppDefinition,
    state: MigrationState,
    target: string,
    did: { createdVolume: boolean; stopped: boolean },
  ) {
    const say = (line: string) => state.log.push(line);
    try {
      if (did.stopped || did.createdVolume)
        await this.apps.mutate(
          before.name,
          async (cur) => ({
            ...cur,
            instanceCount: before.instanceCount,
            volumes: before.volumes,
          }),
          { duringMigration: true },
        );
      say('The app was restored to how it was before the move.');
    } catch (e) {
      this.log.error(
        `Could not restore ${before.name}: ${e instanceof Error ? e.message : e}`,
      );
      say(
        'The app could NOT be restored automatically. Its data is untouched: redeploy it or scale it back up.',
      );
    }
    if (did.createdVolume)
      await this.docker.removeVolume(target).then(
        () => say('The partly copied new volume was removed.'),
        () =>
          say(
            `The new volume ${target} could not be removed: remove it from Storage.`,
          ),
      );
  }
}
