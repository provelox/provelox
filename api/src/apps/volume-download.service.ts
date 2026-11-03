import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { serviceName } from '../common/naming';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import type { AppDefinition } from './app.model';
import { AppsService } from './apps.service';
import { mountSource } from './service-spec';

/** What is read from the stream before the answer is started, so a copy that fails at once can still say why */
export interface VolumeDownload {
  filename: string;
  stream: Readable;
  /**
   * Resolves when the copy is over and the app is as it was before (started again, when it was stopped for the copy).
   * `ok` is false when the archive is not complete. Never rejects.
   */
  finished: Promise<{ ok: boolean; detail: string }>;
  /** The reader went away: stop copying and put everything back */
  abort(): Promise<void>;
  /** Whether the app was stopped for the copy */
  stopped: boolean;
}

/** tar exits 1 when it skipped files that changed or vanished while it read them; the archive itself is complete. */
const TAR_SKIPPED = 1;

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);

/** 20260102-030405, in UTC */
export const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d+Z$/, '');

/**
 * Hands out the contents of an app's named volume as a .tar.gz, to take its data off the server. Reads the volume from
 * a helper that has it mounted read-only, no network and no privileges; the archive is streamed, never held. The volume
 * is looked up in the app's own definition, so only a volume the app really has can be asked for.
 */
@Injectable()
export class VolumeDownloadService {
  private readonly log = new Logger('VolumeDownload');
  /** How long stopping the app for a consistent copy may take before giving up */
  waitMs = 60_000;
  pollMs = 500;

  constructor(
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** The app's named volume called `volume`, and the Docker volume behind it. Refuses anything else. */
  resolve(appName: string, volume: string) {
    const app = this.apps.getDefinition(appName);
    const mount = app.volumes.find((v) => v.volumeName === volume);
    if (!mount) {
      const bind = app.volumes.find(
        (v) =>
          !v.volumeName &&
          (v.hostPath === volume || v.containerPath === volume),
      );
      if (bind)
        throw new ValidationError(
          `${bind.containerPath} of "${appName}" is a directory of the server (${bind.hostPath}), not a volume Provelox keeps. Copy it from the server itself.`,
        );
      throw new NotFoundError(`"${appName}" has no volume named "${volume}".`);
    }
    return { app, mount, dockerName: mountSource(app, mount) };
  }

  /** Where the data is, when it is not on this machine: the volume can only be read where it lives. */
  async elsewhere(app: AppDefinition): Promise<string | null> {
    const local = await this.docker.localNodeId();
    if (!local) return null;
    const held = this.apps.heldTo(app.name);
    const nodeId =
      held?.id ?? (await this.docker.lastTaskNode(serviceName(app.name)));
    if (!nodeId || nodeId === local) return null;
    const host =
      held?.host ??
      (await this.docker.listNodes().catch(() => [])).find(
        (n) => n.id === nodeId,
      )?.hostname ??
      'another machine';
    return host;
  }

  async open(
    appName: string,
    volume: string,
    opts: { stop?: boolean } = {},
    now = new Date(),
  ): Promise<VolumeDownload> {
    const { app, dockerName } = this.resolve(appName, volume);
    const other = await this.elsewhere(app);
    if (other)
      throw new ConflictError(
        `The data of "${appName}" is on ${other}. This API can only read volumes on the machine it runs on for now: download it from there.`,
      );
    if (!(await this.docker.volumeExists(dockerName)))
      throw new ConflictError(
        `The volume "${volume}" of "${appName}" does not exist yet: the app has not started with it, so there is nothing to download.`,
      );

    const before = app.instanceCount;
    const stopFirst = !!opts.stop && before > 0;
    if (opts.stop) {
      if (app.blueprint)
        throw new ConflictError(
          `"${appName}" is managed by a hub, which would start it again while it is copied. Download without stopping it, or stop it from the hub.`,
        );
      if (before > 1)
        throw new ConflictError(
          `"${appName}" runs ${before} instances, so stopping it for a copy is not something Provelox can do safely. Download without stopping it.`,
        );
    }

    // From the moment the app is stopped, putting it back is owed, whatever happens next
    let putBack: Promise<void> | null = null;
    const restore = () =>
      (putBack ??= (async () => {
        if (!stopFirst) return;
        try {
          await this.apps.mutate(
            appName,
            async (cur) => ({ ...cur, instanceCount: before }),
            { duringMigration: true },
          );
        } finally {
          this.apps.unblock(appName);
        }
      })());

    if (stopFirst) {
      this.apps.block(appName);
      try {
        await this.apps.mutate(
          appName,
          async (cur) => ({ ...cur, instanceCount: 0 }),
          { duringMigration: true },
        );
        const end = Date.now() + this.waitMs;
        while ((await this.docker.countContainers(serviceName(appName))) > 0) {
          if (Date.now() > end)
            throw new ConflictError(
              `"${appName}" did not stop within ${Math.round(this.waitMs / 1000)} seconds. It was started again; nothing was copied.`,
            );
          await new Promise((r) => setTimeout(r, this.pollMs));
        }
      } catch (e) {
        await restore().catch((err) =>
          this.log.error(
            `Could not start ${appName} again after a failed stop: ${err instanceof Error ? err.message : err}`,
          ),
        );
        throw e;
      }
    }

    let helper;
    try {
      helper = await this.docker.streamHelper({
        image: this.cfg.HELPER_IMAGE,
        entrypoint: ['tar'],
        // gzip is part of tar here; "-" is standard output
        command: ['-c', '-z', '-f', '-', '-C', '/data', '.'],
        mounts: [{ volume: dockerName, target: '/data', readOnly: true }],
      });
    } catch (e) {
      await restore().catch(() => undefined);
      throw new ServiceUnavailableException(
        `Could not start the copy: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }

    const finished = helper.done.then(async (r) => {
      await restore().catch((err) =>
        this.log.error(
          `Could not start ${appName} again after the copy: ${err instanceof Error ? err.message : err}`,
        ),
      );
      const ok = r.exitCode === 0 || r.exitCode === TAR_SKIPPED;
      return {
        ok,
        detail:
          r.exitCode === 0
            ? ''
            : r.exitCode === TAR_SKIPPED
              ? `Some files changed or vanished while they were read and were left out. ${r.stderr}`.trim()
              : `The copy stopped with exit code ${r.exitCode}. ${r.stderr}`.trim(),
      };
    });

    // Wait for the first bytes (or the end), so a copy that fails at once is an error and not an empty download
    const started = await new Promise<boolean>((resolve) => {
      const s = helper.stdout;
      const cleanup = () => {
        s.off('readable', onReadable);
        s.off('end', onEnd);
        s.off('close', onEnd);
      };
      const onEnd = () => {
        cleanup();
        resolve(s.readableLength > 0);
      };
      const onReadable = () => {
        if (s.readableLength > 0) {
          cleanup();
          resolve(true);
        } else s.read();
      };
      s.on('readable', onReadable);
      s.once('end', onEnd);
      s.once('close', onEnd);
    });
    if (!started) {
      const r = await finished;
      throw new ServiceUnavailableException(
        `Nothing could be read from the volume. ${r.detail}`.trim(),
      );
    }

    return {
      filename: `${slug(appName)}-${slug(volume)}-${stamp(now)}.tar.gz`,
      stream: helper.stdout,
      finished,
      stopped: stopFirst,
      abort: async () => {
        await helper.abort();
        await finished;
      },
    };
  }
}
