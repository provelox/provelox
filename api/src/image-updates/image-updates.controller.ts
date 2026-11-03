import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Scope } from '../auth/scope.decorator';
import { ImageUpdatesService } from './image-updates.service';

@Controller('system/image-updates')
export class ImageUpdatesController {
  constructor(private readonly updates: ImageUpdatesService) {}

  /**
   * For each app, whether the registry has a newer version of its image, or a rebuilt one under the same tag. Answered
   * from a cache (a few hours old at most), so it is cheap to ask often; `checking` says a refresh is under way.
   */
  @Scope('read')
  @Get()
  report() {
    return this.updates.report();
  }

  /** Asks the registries again now. Ignored if it was done in the last minute. */
  @Scope('operate')
  @Post('check')
  @HttpCode(202)
  check() {
    return this.updates.force();
  }
}
