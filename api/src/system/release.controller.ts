import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { Scope } from '../auth/scope.decorator';
import { ReleaseCheckService } from './release-check.service';

/**
 * Whether the project has published a release newer than the one running. It only reports; updating is a separate,
 * deliberate call (`POST /v1/system/update`).
 */
@Controller('system/release')
export class ReleaseController {
  constructor(private readonly releases: ReleaseCheckService) {}

  /** From memory, at once (a few hours old at most); `checking` says a look is under way and `error` why the last one failed. `?notes=0` leaves out the notes; `noteCount` says how many there are. */
  @Scope('read')
  @Get()
  async report(@Query('notes') notes?: string) {
    const status = await this.releases.report();
    // `?notes=0` leaves the release notes out (they can be large), for a caller that only needs to know there is an update
    return notes === '0' ? { ...status, notes: [] } : status;
  }

  /** Looks again now. Ignored if it was done in the last minute. */
  @Scope('operate')
  @Post('check')
  @HttpCode(202)
  check() {
    return this.releases.force();
  }

  /** Turns checking on or off (admin only). The environment's UPDATE_CHECK=false cannot be overridden from here. */
  @Put('settings')
  settings(@Body() body: unknown) {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'Send { "enabled": true } or { "enabled": false }.',
      );
    return this.releases.setEnabled(parsed.data.enabled);
  }
}
