import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Scope } from '../auth/scope.decorator';
import { ValidationError } from '../common/errors';
import { StorageService } from './storage.service';

const volumes = z.object({
  names: z.array(z.string().max(300)).min(1).max(500),
  acknowledgeUnknownOwner: z.boolean().default(false),
});
const images = z.object({
  imageIds: z.array(z.string().max(300)).min(1).max(500),
  keepVersions: z.number().int().min(0).max(50).default(1),
  acknowledgeUnknownOwner: z.boolean().default(false),
});

@Controller('system/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  /** What takes disk, what each thing is, and whether Provelox may delete it. Read-only. */
  @Get()
  report(@Query('keepVersions') keepVersions?: string) {
    return this.storage.report(
      keepVersions === undefined ? 1 : Number(keepVersions),
    );
  }

  /**
   * The sizes, the biggest volumes and images, and what could be cleared. For a monitor, so it is open to a read
   * token: it lists names and sizes, never contents.
   */
  @Scope('read')
  @Get('summary')
  summary() {
    return this.storage.summary();
  }

  /**
   * Deletes the images that are provably unused. It cannot reach a volume, or an image that needs confirming, so it is
   * open to a token that may update.
   */
  @Scope('update')
  @Post('images/prune-unused')
  pruneUnused() {
    return this.storage.pruneImages();
  }

  /** What is inside a volume (read-only). */
  @Get('volumes/peek')
  peek(@Query('name') name?: string) {
    if (!name) throw new ValidationError('Say which volume: ?name=...');
    return this.storage.peek(name);
  }

  @Post('volumes/delete')
  deleteVolumes(@Body() body: unknown) {
    const p = volumes.safeParse(body);
    if (!p.success)
      throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid input');
    return this.storage.deleteVolumes(
      p.data.names,
      p.data.acknowledgeUnknownOwner,
    );
  }

  @Post('images/delete')
  deleteImages(@Body() body: unknown) {
    const p = images.safeParse(body);
    if (!p.success)
      throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid input');
    return this.storage.deleteImages(
      p.data.imageIds,
      p.data.keepVersions,
      p.data.acknowledgeUnknownOwner,
    );
  }
}
