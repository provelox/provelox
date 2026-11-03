import {
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
import { actorOf } from '../activity/actor';
import { ActivityService } from '../activity/activity.service';
import { ValidationError } from '../common/errors';
import { DatabaseBackupService } from './database-backup.service';
import { DatabaseImportService } from './database-import.service';

/**
 * Dump and restore of the database an app runs. No `@Scope`: like the volume download it hands out (and, for a restore,
 * overwrites) data, so it is for the signed-in admin and no access token can use it.
 */
@Controller('apps/:name/database')
export class DatabaseController {
  constructor(
    private readonly backups: DatabaseBackupService,
    private readonly activity: ActivityService,
    private readonly imports: DatabaseImportService,
  ) {}

  /** What database the app runs, and whether it can be backed up */
  @Get()
  info(@Param('name') name: string) {
    return this.backups.info(name);
  }

  /**
   * A dump of the database, streamed. `?all=1` dumps every database of the server. The response is ended by hand once
   * the tool's exit code is known: a dump that died half way cuts the connection and never looks complete.
   */
  @Get('dump')
  async dump(
    @Param('name') name: string,
    @Query('all') all: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const dump = await this.backups.dump(name, { all: all === '1' });
    const actor = actorOf(req);
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'database.dump',
          target: name,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 499,
          summary,
        });
    };
    const what =
      all === '1' ? 'a dump of all databases' : 'a dump of the database';
    res.once('close', () => {
      if (!res.writableFinished) void dump.abort();
    });
    res.set({
      'Content-Type': dump.contentType,
      'Content-Disposition': `attachment; filename="${dump.filename}"`,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    dump.stream.pipe(res, { end: false });
    const r = await dump.finished;
    if (res.destroyed) return void record(false, `${what} was cancelled`);
    if (r.ok) {
      res.end();
      record(true, `downloaded ${what}`);
    } else {
      res.destroy();
      record(false, `${what} failed`);
    }
  }

  /**
   * Saves a dump of the database into the import folder on the server (a .dump for PostgreSQL's own format, a .sql.gz for
   * the rest), so it can be moved with rsync or scp without a browser. `?all=1` dumps every database of the server. The
   * file only appears when the dump is whole. Admin only; the app keeps running.
   */
  @Post('export')
  @HttpCode(200)
  async exportDump(
    @Param('name') name: string,
    @Query('all') all: string | undefined,
    @Req() req: Request,
  ) {
    const actor = actorOf(req);
    const what =
      all === '1'
        ? 'a dump of all databases to the import folder'
        : 'a dump of the database to the import folder';
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'database.export',
          target: name,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 500,
          summary,
        });
    };
    try {
      const r = await this.imports.exportDump(name, { all: all === '1' });
      record(true, `saved ${what} as ${r.file}`);
      return r;
    } catch (e) {
      // No tool output in the record: it can quote the data
      record(false, `saving ${what} failed`);
      throw e;
    }
  }

  /**
   * Restores a dump, sent as the body of the request and streamed into the database's own tool. `clean=1` replaces what
   * is there and needs `confirm` to be the app's name.
   *
   * With `from=<file name>` and no body, the dump is a file already in the import folder on the server (put there with
   * rsync or scp, or saved by `export`): nothing is uploaded, so there is no limit on its size.
   */
  @Post('restore')
  @HttpCode(200)
  async restore(
    @Param('name') name: string,
    @Query('clean') clean: string | undefined,
    @Query('confirm') confirm: string | undefined,
    @Query('from') from: string | undefined,
    @Req() req: Request,
  ) {
    const actor = actorOf(req);
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'database.restore',
          target: name,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 500,
          summary,
        });
    };
    if (from !== undefined) {
      const what =
        clean === '1'
          ? `replaced the contents of the database from the server file "${from}"`
          : `restored into the database from the server file "${from}"`;
      try {
        // A file on the server and an upload are two ways to the same thing: asking for both is a mistake, not a choice
        if (
          Number(req.headers['content-length'] ?? 0) > 0 ||
          req.headers['transfer-encoding']
        )
          throw new ValidationError(
            'Send either a dump as the body, or from=<a file in the import folder>, not both.',
          );
        const r = await this.imports.restoreFrom(name, from, {
          clean: clean === '1',
          confirm,
        });
        record(true, what);
        return r;
      } catch (e) {
        // No tool output in the record: it can quote the data
        record(false, `restoring the database from "${from}" failed`);
        throw e;
      }
    }
    // The browser leaving mid-upload stops the tool in the container
    const gone = new AbortController();
    req.once('close', () => {
      if (!req.complete) gone.abort();
    });
    const what =
      clean === '1'
        ? 'replaced the contents of the database'
        : 'restored into the database';
    try {
      const r = await this.backups.restore(name, req, {
        clean: clean === '1',
        confirm,
        signal: gone.signal,
      });
      record(true, what);
      return r;
    } catch (e) {
      // No tool output in the record: it can quote the data
      record(false, 'restoring the database failed');
      throw e;
    }
  }
}
