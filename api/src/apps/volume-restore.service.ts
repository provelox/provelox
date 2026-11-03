import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PassThrough, type Readable } from 'node:stream';
import { ConflictError, ValidationError } from '../common/errors';
import { serviceName } from '../common/naming';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { AppsService } from './apps.service';
import { VolumeDownloadService } from './volume-download.service';

/**
 * What tar needs on top of nothing: to make files its own (`CHOWN`), to set modes and times on files it does not own
 * (`FOWNER`), and to write into directories whose owner is someone else, such as a database's private folder
 * (`DAC_OVERRIDE`). Without them a restored database refuses to start, because its files belong to the wrong user.
 */
export const RESTORE_CAPABILITIES = ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'];

/** The program that extracts. Fixed text: nothing of what a person sends is ever part of a command. */
export const EXTRACT = ['tar', '-x', '-z', '-p', '-f', '-', '-C', '/data'];
/** Replacing: the volume is emptied first, inside the same helper */
export const EMPTY_THEN_EXTRACT =
  'find /data -mindepth 1 -delete && exec tar -x -z -p -f - -C /data';

export interface VolumeRestoreResult {
  restored: true;
  /** What was received */
  bytes: number;
  /** Whether what was in the volume was removed first */
  replaced: boolean;
  /** Whether the app was stopped (it was running) and started again */
  stopped: boolean;
}

/** The first bytes of a gzip file */
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** The first chunk of a stream, put back so the stream still starts at its beginning. Null for an empty one. */
async function peek(input: Readable): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const done = (v: Buffer | null) => {
      input.off('readable', onReadable);
      input.off('end', onEnd);
      input.off('error', reject);
      input.off('close', onEnd);
      resolve(v);
    };
    const onReadable = () => {
      const c = input.read() as Buffer | null;
      if (!c) return;
      input.unshift(c);
      done(c);
    };
    const onEnd = () => done(null);
    input.on('readable', onReadable);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.once('error', reject);
    onReadable();
  });
}

/**
 * Puts the contents of a .tar.gz into one of an app's named volumes: the way back from a download, such as onto a rebuilt
 * server. The archive is untrusted, so it is extracted by a helper that can write only to that volume (no network, a
 * read-only system, no privileges beyond giving files their owners), and it is streamed, never held. The app is stopped
 * while data is written, and started again however it ends.
 */
@Injectable()
export class VolumeRestoreService {
  private readonly log = new Logger('VolumeRestore');
  waitMs = 60_000;
  pollMs = 500;

  constructor(
    private readonly downloads: VolumeDownloadService,
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** Whether nothing is in the volume, looked at read-only. */
  private async isEmpty(dockerName: string): Promise<boolean> {
    let h;
    try {
      h = await this.docker.streamHelper({
        image: this.cfg.HELPER_IMAGE,
        entrypoint: ['ls'],
        command: ['-A', '/data'],
        mounts: [{ volume: dockerName, target: '/data', readOnly: true }],
      });
    } catch (e) {
      throw new ServiceUnavailableException(
        `Could not look into the volume: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
    let seen = 0;
    for await (const c of h.stdout) seen += (c as Buffer).length;
    const r = await h.done;
    if (r.exitCode !== 0)
      throw new ServiceUnavailableException(
        `Could not look into the volume. ${r.stderr}`.trim(),
      );
    return seen === 0;
  }

  async restore(
    appName: string,
    volume: string,
    input: Readable,
    opts: { replace?: boolean; confirm?: string } = {},
  ): Promise<VolumeRestoreResult> {
    const { app, dockerName } = this.downloads.resolve(appName, volume);
    const replace = !!opts.replace;
    if (replace && opts.confirm !== appName)
      throw new ValidationError(
        `Replacing what is in the volume removes it. Confirm by sending the app's name, "${appName}", as confirm.`,
      );
    const other = await this.downloads.elsewhere(app);
    if (other)
      throw new ConflictError(
        `The data of "${appName}" is on ${other}. This API can only write volumes on the machine it runs on for now: restore it from there.`,
      );
    if (!(await this.docker.volumeExists(dockerName)))
      throw new ConflictError(
        `The volume "${volume}" of "${appName}" does not exist yet: start the app once so it is created, then restore into it.`,
      );
    if (app.blueprint)
      throw new ConflictError(
        `"${appName}" is managed by a hub, which would start it again while data is written. Stop it from the hub and restore from the machine itself.`,
      );
    const before = app.instanceCount;
    if (before > 1)
      throw new ConflictError(
        `"${appName}" runs ${before} instances, so stopping it to restore data is not something Provelox can do safely.`,
      );

    // Nothing is touched before the upload looks like what it should be
    const first = await peek(input);
    if (!first || !isGzip(first))
      throw new ValidationError(
        'That is not a .tar.gz archive. Upload a file made by Download, or any tar archive compressed with gzip.',
      );
    if (!replace && !(await this.isEmpty(dockerName)))
      throw new ConflictError(
        `The volume "${volume}" of "${appName}" is not empty. Restoring would mix the archive into what is there. Choose to replace it (download a copy first) or restore into an empty volume.`,
      );

    const stop = before > 0;
    let putBack: Promise<void> | null = null;
    const restoreApp = () =>
      (putBack ??= (async () => {
        if (!stop) return;
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

    if (stop) {
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
              `"${appName}" did not stop within ${Math.round(this.waitMs / 1000)} seconds. It was started again; nothing was written.`,
            );
          await new Promise((r) => setTimeout(r, this.pollMs));
        }
      } catch (e) {
        await restoreApp().catch((err) =>
          this.log.error(
            `Could not start ${appName} again after a failed stop: ${err instanceof Error ? err.message : err}`,
          ),
        );
        throw e;
      }
    }

    let bytes = 0;
    const counted = new PassThrough();
    counted.on('data', (c: Buffer) => (bytes += c.length));
    let aborted = false;
    try {
      let helper;
      try {
        helper = await this.docker.streamHelper({
          image: this.cfg.HELPER_IMAGE,
          kind: 'restore',
          entrypoint: replace ? ['sh'] : [EXTRACT[0]],
          command: replace ? ['-c', EMPTY_THEN_EXTRACT] : EXTRACT.slice(1),
          mounts: [{ volume: dockerName, target: '/data', readOnly: false }],
          capabilities: RESTORE_CAPABILITIES,
          input: counted,
        });
      } catch (e) {
        throw new ServiceUnavailableException(
          `Could not start the restore: ${e instanceof Error ? e.message : 'unknown error'}`,
        );
      }
      // tar writes nothing to its output, but the helper is not over until what it says has been read
      helper.stdout.resume();
      const stopHelper = () => {
        aborted = true;
        void helper.abort();
      };
      // The sender went away before the end of the archive: whatever tar has is incomplete, stop it
      input.once('error', stopHelper);
      input.once('close', () => {
        if (!input.readableEnded) stopHelper();
      });
      input.pipe(counted);
      const r = await helper.done;
      if (aborted)
        throw new ConflictError(
          `The upload stopped before the end, so the restore was cancelled.${replace ? ` The volume had been emptied first and is now partly written: restore a copy of it again.` : ' The volume may be partly written.'}`,
        );
      if (r.exitCode !== 0)
        throw new ServiceUnavailableException(
          `The restore failed (exit code ${r.exitCode}). ${r.stderr}`.trim() +
            (replace
              ? ' The volume was emptied first and may be partly written: restore a copy of it again.'
              : ' The volume may be partly written.'),
        );
    } finally {
      await restoreApp().catch((err) =>
        this.log.error(
          `Could not start ${appName} again after the restore: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
    return { restored: true, bytes, replaced: replace, stopped: stop };
  }
}
