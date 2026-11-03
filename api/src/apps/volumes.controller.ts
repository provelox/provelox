import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { actorOf } from '../activity/actor';
import { ActivityService } from '../activity/activity.service';
import { ValidationError } from '../common/errors';
import { NotFoundError } from '../common/errors';
import { MountsService } from './mounts.service';
import { VolumeDownloadService } from './volume-download.service';
import { VolumeImportService } from './volume-import.service';
import { VolumeRestoreService } from './volume-restore.service';
import { VolumeMigrationService } from './volume-migration.service';

const migrate = z.object({
  containerPath: z
    .string()
    .regex(/^\/[^\0:]*$/, 'The path must be absolute, like /data')
    .max(500),
  volumeName: z.string().max(100),
});

@Controller('apps/:name/volumes')
export class VolumesController {
  constructor(
    private readonly migration: VolumeMigrationService,
    private readonly mounts: MountsService,
    private readonly downloads: VolumeDownloadService,
    private readonly restores: VolumeRestoreService,
    private readonly imports: VolumeImportService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Everything the app has mounted: declared mounts (with Docker names and, with ?sizes=1, sizes) and the unmanaged
   * volumes its image created. Sizes make Docker walk every volume, so they are opt-in.
   */
  @Get()
  list(@Param('name') name: string, @Query('sizes') sizes?: string) {
    return this.mounts.get(name, sizes === '1');
  }

  /**
   * The contents of one of the app's named volumes as a .tar.gz, streamed. Admin only: it hands out data, secrets
   * included. Live by default; ?stop=1 stops the app while it is copied (and starts it again after, however the copy
   * ends), which is the way to get a consistent copy of a database. Only volumes on the machine the API runs on.
   */
  @Get(':volume/download')
  async download(
    @Param('name') name: string,
    @Param('volume') volume: string,
    @Query('stop') stop: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const dl = await this.downloads.open(name, volume, { stop: stop === '1' });
    const actor = actorOf(req);
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'volume.download',
          target: name,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 499,
          summary,
        });
    };
    // The client went away before the end: stop reading the volume and put the app back
    res.once('close', () => {
      if (!res.writableFinished) void dl.abort();
    });
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${dl.filename}"`,
      'Cache-Control': 'no-store',
      // a proxy must not hold a large download back to compress or collect it
      'X-Accel-Buffering': 'no',
    });
    // The response is ended by hand, after the exit code is known: a copy that died half way must not look complete
    dl.stream.pipe(res, { end: false });
    const what = `volume "${volume}"${dl.stopped ? ' (the app was stopped for the copy)' : ''}`;
    const r = await dl.finished;
    if (res.destroyed)
      return void record(false, `downloading ${what} was cancelled`);
    if (r.ok) {
      res.end();
      record(true, `downloaded ${what}`);
    } else {
      res.destroy();
      record(false, `downloading ${what} failed`);
    }
  }

  /**
   * Puts a .tar.gz (the body, streamed) into one of the app's named volumes. Admin only. Into an empty volume by default;
   * ?replace=1&confirm=<the app's name> empties it first, which cannot be undone. The app is stopped while data is
   * written and started again however it ends. Only volumes on the machine the API runs on.
   *
   * With `from=<file name>` and no body, the archive is a file already in the import folder on the server (put there with
   * rsync or scp): nothing is uploaded, so there is no limit on its size, and the work goes on if the caller hangs up.
   */
  @Post(':volume/restore')
  async restore(
    @Param('name') name: string,
    @Param('volume') volume: string,
    @Query('replace') replace: string | undefined,
    @Query('confirm') confirm: string | undefined,
    @Query('from') from: string | undefined,
    @Req() req: Request,
  ) {
    const actor = actorOf(req);
    const what = `volume "${volume}"${from !== undefined ? ` from the server file "${from}"` : ''}${replace === '1' ? ' (replacing what was there)' : ''}`;
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'volume.restore',
          target: name,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 500,
          summary,
        });
    };
    try {
      if (from !== undefined) {
        // A file on the server and an upload are two ways to the same thing: asking for both is a mistake, not a choice
        if (
          Number(req.headers['content-length'] ?? 0) > 0 ||
          req.headers['transfer-encoding']
        )
          throw new ValidationError(
            'Send either an archive as the body, or from=<a file in the import folder>, not both.',
          );
        const r = await this.imports.restoreFrom(name, volume, from, {
          replace: replace === '1',
          confirm,
        });
        record(true, `restored ${what}`);
        return r;
      }
      const r = await this.restores.restore(name, volume, req, {
        replace: replace === '1',
        confirm,
      });
      record(true, `restored ${what}`);
      return r;
    } catch (e) {
      record(false, `restoring ${what} failed`);
      throw e;
    }
  }

  /**
   * Saves a copy of one of the app's named volumes into the import folder on the server, as a .tar.gz, so it can be moved
   * with rsync or scp (to another server, say) without a browser. Admin only. Live by default; ?stop=1 stops the app
   * while it is copied and starts it again however the copy ends. The file only appears when it is complete.
   */
  @Post(':volume/export')
  async exportVolume(
    @Param('name') name: string,
    @Param('volume') volume: string,
    @Query('stop') stop: string | undefined,
    @Req() req: Request,
  ) {
    const actor = actorOf(req);
    const what = `volume "${volume}" to the import folder`;
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'volume.export',
          target: name,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 500,
          summary,
        });
    };
    try {
      const r = await this.imports.exportVolume(name, volume, {
        stop: stop === '1',
      });
      record(
        true,
        `saved ${what} as ${r.file}${r.stopped ? ' (the app was stopped for the copy)' : ''}`,
      );
      return r;
    } catch (e) {
      record(false, `saving ${what} failed`);
      throw e;
    }
  }

  /** Mounts the running app has that Provelox does not manage (usually unnamed volumes the image creates). */
  @Get('detected')
  detected(@Param('name') name: string) {
    return this.migration.detect(name);
  }

  /** Moves the data at a path into a named volume, in the background. Poll GET migration. */
  @Post('migrate')
  @HttpCode(202)
  migrate(@Param('name') name: string, @Body() body: unknown) {
    const p = migrate.safeParse(body);
    if (!p.success)
      throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid input');
    return this.migration.start(name, p.data.containerPath, p.data.volumeName);
  }

  /** Release the helper that holds the original volume after a failed move (the original can then be deleted). */
  @Post('migration/release')
  release(@Param('name') name: string) {
    return this.migration.releaseHold(name);
  }

  @Get('migration')
  state(@Param('name') name: string) {
    const s = this.migration.get(name);
    if (!s) throw new NotFoundError('No data move has run for this app.');
    return s;
  }
}
