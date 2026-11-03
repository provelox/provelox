import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConflictError, ValidationError } from '../common/errors';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import {
  REPLACE_FROM_SCRIPT,
  RESTORE_FROM_SCRIPT,
  exportFileName,
} from '../imports/imports';
import { ImportsService } from '../imports/imports.service';
import { AppsService } from './apps.service';
import { VolumeDownloadService } from './volume-download.service';
import { RESTORE_CAPABILITIES } from './volume-restore.service';
import { withAppStopped } from './with-app-stopped';

export interface VolumeFromFileResult {
  restored: true;
  /** The file that was restored, and its size */
  file: string;
  bytes: number;
  replaced: boolean;
  /** Whether the app was stopped (it was running) and started again */
  stopped: boolean;
}

export interface VolumeExportResult {
  /** The file now in the import folder, and its size */
  file: string;
  sizeBytes: number;
  /** Where the folder is on the server */
  dir: string;
  stopped: boolean;
  /** Something to tell, such as files that changed while they were copied. Empty when there is nothing. */
  note: string;
}

/**
 * Moves a volume's data through the import folder on the server: restore from a file that was put there (rsync, scp), and
 * save a copy of a volume into it. The same rules as the browser download and upload (the volume is looked up in the
 * app's own definition, the app is stopped while data moves and started again however it ends), without a browser in
 * between, so there is no time limit on how big the data is. The file is only ever named, then found in the folder.
 */
@Injectable()
export class VolumeImportService {
  private readonly log = new Logger('VolumeImport');
  waitMs = 60_000;
  pollMs = 500;

  constructor(
    private readonly downloads: VolumeDownloadService,
    private readonly imports: ImportsService,
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** Whether nothing is in the volume, looked at read-only. */
  private async isEmpty(dockerName: string): Promise<boolean> {
    const r = await this.imports.run(
      {
        entrypoint: ['ls'],
        command: ['-A', '/data'],
        mounts: [{ volume: dockerName, target: '/data', readOnly: true }],
      },
      'look into the volume',
    );
    if (r.exitCode !== 0)
      throw new ServiceUnavailableException(
        `Could not look into the volume. ${r.stderr}`.trim(),
      );
    return r.stdout.length === 0;
  }

  /** Puts the contents of a .tar.gz that is in the import folder into one of the app's volumes. */
  async restoreFrom(
    appName: string,
    volume: string,
    fileName: unknown,
    opts: { replace?: boolean; confirm?: string } = {},
  ): Promise<VolumeFromFileResult> {
    const { app, dockerName } = this.downloads.resolve(appName, volume);
    const replace = !!opts.replace;
    // Only a volume archive: a database dump is never unpacked into a volume
    this.imports.assertName(fileName, 'volume');
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

    // Nothing is touched before the file is known to be there, to be gzip, and to fit
    const { file, listing } = await this.imports.find(fileName, 'volume');
    if (!file.gzip)
      throw new ValidationError(
        `"${file.name}" is not a gzip archive. Put a .tar.gz made by Download or Save a copy, or any tar archive compressed with gzip.`,
      );
    if (listing.freeBytes !== null && listing.freeBytes < file.sizeBytes)
      throw new ConflictError(
        `There is less free space on the server (${listing.freeBytes} bytes) than the archive itself (${file.sizeBytes} bytes), and it grows when unpacked. Free some space first.`,
      );
    if (!replace && !(await this.isEmpty(dockerName)))
      throw new ConflictError(
        `The volume "${volume}" of "${appName}" is not empty. Restoring would mix the archive into what is there. Choose to replace it (save a copy first) or restore into an empty volume.`,
      );

    const { stopped } = await withAppStopped(
      {
        apps: this.apps,
        docker: this.docker,
        log: this.log,
        waitMs: this.waitMs,
        pollMs: this.pollMs,
      },
      appName,
      before,
      'nothing was written',
      async () => {
        const r = await this.imports.run(
          {
            entrypoint: ['sh'],
            command: [
              '-c',
              replace ? REPLACE_FROM_SCRIPT : RESTORE_FROM_SCRIPT,
              'sh',
              file.name,
            ],
            mounts: [
              { volume: dockerName, target: '/data', readOnly: false },
              this.imports.mount(true),
            ],
            capabilities: RESTORE_CAPABILITIES,
          },
          'start the restore',
        );
        if (r.exitCode === 3)
          throw new ConflictError(
            `"${file.name}" changed since it was listed (it is no longer a plain gzip file), so nothing was written. ${r.stderr}`.trim(),
          );
        if (r.exitCode !== 0)
          throw new ServiceUnavailableException(
            `The restore failed (exit code ${r.exitCode}). ${r.stderr}`.trim() +
              (replace
                ? ' The volume was emptied first and may be partly written: restore it again.'
                : ' The volume may be partly written.'),
          );
      },
    );
    return {
      restored: true,
      file: file.name,
      bytes: file.sizeBytes,
      replaced: replace,
      stopped,
    };
  }

  /** Saves a copy of one of the app's volumes into the import folder, as a .tar.gz named for the app, volume and time. */
  async exportVolume(
    appName: string,
    volume: string,
    opts: { stop?: boolean } = {},
    now = new Date(),
  ): Promise<VolumeExportResult> {
    const { app, dockerName } = this.downloads.resolve(appName, volume);
    const other = await this.downloads.elsewhere(app);
    if (other)
      throw new ConflictError(
        `The data of "${appName}" is on ${other}. This API can only read volumes on the machine it runs on for now: save the copy from there.`,
      );
    if (!(await this.docker.volumeExists(dockerName)))
      throw new ConflictError(
        `The volume "${volume}" of "${appName}" does not exist yet: the app has not started with it, so there is nothing to copy.`,
      );
    const before = app.instanceCount;
    if (opts.stop) {
      if (app.blueprint)
        throw new ConflictError(
          `"${appName}" is managed by a hub, which would start it again while it is copied. Copy it without stopping it, or stop it from the hub.`,
        );
      if (before > 1)
        throw new ConflictError(
          `"${appName}" runs ${before} instances, so stopping it for a copy is not something Provelox can do safely. Copy it without stopping it.`,
        );
    }
    const file = exportFileName(appName, volume, now);
    const { value, stopped } = await withAppStopped(
      {
        apps: this.apps,
        docker: this.docker,
        log: this.log,
        waitMs: this.waitMs,
        pollMs: this.pollMs,
      },
      appName,
      opts.stop ? before : 0,
      'nothing was copied',
      () => this.imports.exportVolume(dockerName, file),
    );
    return {
      file,
      sizeBytes: value.sizeBytes,
      dir: this.imports.dir,
      stopped,
      note: value.note,
    };
  }
}
