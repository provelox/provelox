import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
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

  /** From memory, at once (a few hours old at most); `checking` says a look is under way and `error` why the last one failed */
  @Scope('read')
  @Get()
  report() {
    return this.releases.report();
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
