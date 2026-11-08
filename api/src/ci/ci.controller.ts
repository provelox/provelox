import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { setActor } from '../activity/actor';
import { z } from 'zod';
import { AppsService } from '../apps/apps.service';
import { DeploymentsService } from '../apps/deployments.service';
import { Public } from '../auth/public.decorator';
import { ValidationError } from '../common/errors';
import {
  imageRepository,
  parseImageRepository,
} from '../common/image-repository';
import { CiKeysService } from './ci-keys.service';

const create = z.object({
  app: z.string().max(60),
  name: z.string().max(200),
  repository: z.string().max(300).optional(),
});
const deploy = z.object({ image: z.string().max(300) });

/** Management of deploy keys (signed-in admin). */
@Controller('ci-keys')
export class CiKeysController {
  constructor(
    private readonly keys: CiKeysService,
    private readonly apps: AppsService,
  ) {}

  @Get()
  list(@Query('app') app?: string) {
    return this.keys.list(app || undefined);
  }

  /**
   * The `key` in the response is the only time it is ever shown. The key may deploy the image repository it is given;
   * without one, the app's current image repository. An app with no image needs one given.
   */
  @Post()
  create(@Body() body: unknown) {
    const parsed = create.safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'Send { "app": "...", "name": "...", "repository": "ghcr.io/you/app" }.',
      );
    const app = this.apps.getDefinition(parsed.data.app); // 404 for unknown apps
    let repository: string | null = null;
    if (parsed.data.repository?.trim()) {
      repository = parseImageRepository(parsed.data.repository);
      if (!repository)
        throw new ValidationError(
          'The image must be a repository, like ghcr.io/acme/web (a tag is not needed).',
        );
    } else if (app.image) {
      repository = imageRepository(app.image);
    }
    if (!repository)
      throw new ValidationError(
        'Name the image this key may deploy, like ghcr.io/acme/web. The app has no image yet.',
      );
    return this.keys.create(parsed.data.app, parsed.data.name, repository);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@Param('id') id: string) {
    this.keys.revoke(id);
  }
}

/** What a pipeline calls. Authenticated by a deploy key, never by an admin session. */
@Controller('ci')
export class CiController {
  constructor(
    private readonly keys: CiKeysService,
    private readonly apps: AppsService,
    private readonly deployments: DeploymentsService,
  ) {}

  @Public()
  @Post('deploy')
  @HttpCode(202)
  async deploy(
    @Headers('authorization') auth: string | undefined,
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const key = this.keys.authenticate(auth, req.ip ?? 'unknown');
    // Known from here on, so the deploy is in the activity log under the key's name
    setActor(req, { kind: 'ci', name: key.name, app: key.app });
    const parsed = deploy.safeParse(body);
    if (!parsed.success)
      throw new ValidationError('Send { "image": "registry/name:tag" }.');
    // A deploy key may only run the image repository it was created for. A leaked key therefore cannot run something
    // else with the app's secrets and data, even before the app has its first image.
    this.apps.assertSameImageRepository(key.app, parsed.data.image, {
      keyRepository: key.repository,
    });
    const view = await this.apps.deploy(key.app, parsed.data.image);
    this.keys.recordUse(key.id, view.app.image);
    this.deployments.track(key.app, view.app.deployVersion, view.app.image);
    return {
      app: key.app,
      version: view.app.deployVersion,
      image: view.app.image,
    };
  }

  /** Progress of the deploy it just started, so the pipeline can wait for it. */
  @Public()
  @Get('deployment')
  deployment(
    @Headers('authorization') auth: string | undefined,
    @Req() req: Request,
  ) {
    const key = this.keys.authenticate(auth, req.ip ?? 'unknown');
    return (
      this.deployments.get(key.app) ?? {
        app: key.app,
        isBuilding: false,
        isFailed: false,
        lines: [],
      }
    );
  }
}
