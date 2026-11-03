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
import { CiKeysService } from './ci-keys.service';

const create = z.object({ app: z.string().max(60), name: z.string().max(200) });
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

  /** The `key` in the response is the only time it is ever shown. */
  @Post()
  create(@Body() body: unknown) {
    const parsed = create.safeParse(body);
    if (!parsed.success)
      throw new ValidationError('Send { "app": "...", "name": "..." }.');
    this.apps.getDefinition(parsed.data.app); // 404 for unknown apps
    return this.keys.create(parsed.data.app, parsed.data.name);
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
    // A deploy key rolls the app to a new version of its image; the first deploy may name the image. A leaked key
    // therefore cannot run something else with the app's secrets and data.
    this.apps.assertSameImageRepository(key.app, parsed.data.image, {
      allowFirstDeploy: true,
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
