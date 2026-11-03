import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorOf } from '../activity/actor';
import { ActivityService } from '../activity/activity.service';
import { ImportsService } from './imports.service';

/**
 * The import folder on the server: what is in it, and removing a file. Admin only (no `@Scope`): the folder holds copies
 * of data, secrets included. Files get there by rsync or scp, or by saving a copy of a volume.
 */
@Controller('system/imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly activity: ActivityService,
  ) {}

  /** `{dir, files: [{name, sizeBytes, modifiedAt, gzip}], freeBytes}`, newest first */
  @Get()
  list() {
    return this.imports.list();
  }

  /** Removes one file. Cannot be undone: the file name has to be sent again as `confirm`. */
  @Delete(':file')
  @HttpCode(200)
  async remove(
    @Param('file') file: string,
    @Query('confirm') confirm: string | undefined,
    @Req() req: Request,
  ) {
    const actor = actorOf(req);
    const record = (ok: boolean, summary: string) => {
      if (actor)
        this.activity.record({
          actor,
          action: 'import.delete',
          target: null,
          outcome: ok ? 'ok' : 'failed',
          status: ok ? 200 : 500,
          summary,
        });
    };
    try {
      await this.imports.remove(file, confirm);
      record(true, `deleted ${file} from the import folder`);
      return { removed: true };
    } catch (e) {
      record(false, `deleting ${file} from the import folder failed`);
      throw e;
    }
  }
}
