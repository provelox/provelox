import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { appConfigView } from './app-config-view';
import { AppsService } from './apps.service';
import { Scope } from '../auth/scope.decorator';
import { DeploymentsService } from './deployments.service';
import { UsageHistoryService } from './usage-history.service';

const deploy = z.object({ image: z.string().max(300) });
const renameBody = z
  .object({
    name: z.string().max(200),
    updateReferences: z.boolean().default(false),
    keepOldName: z.boolean().default(false),
  })
  .strict();
const scale = z.object({ instances: z.number().int().min(1).max(20) }).strict();

/**
 * What an access token is told about an app it has just acted on. The full definition holds the environment
 * variables, which are secrets, and a token that may restart an app is not for reading them: only a signed-in admin
 * gets the whole view.
 */
export function viewFor<
  T extends {
    app: {
      name: string;
      image?: string | null;
      instanceCount: number;
      deployVersion: number;
    };
  },
>(req: Request, view: T) {
  if (!(req as Request & { tokenScope?: string }).tokenScope) return view;
  const { app, ...rest } = view as T & Record<string, unknown>;
  return {
    app: {
      name: app.name,
      image: app.image ?? null,
      instanceCount: app.instanceCount,
      deployVersion: app.deployVersion,
    },
    status: rest.status ?? null,
    hosts: rest.hosts ?? [],
    building: rest.building ?? false,
  };
}

@Controller('apps')
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly deployments: DeploymentsService,
    private readonly usageHistory: UsageHistoryService,
  ) {}

  /** Adds whether a deploy is being followed right now, which the apps service itself does not know */
  private withBuilding<T extends { app: { name: string } }>(view: T) {
    return {
      ...view,
      building: this.deployments.get(view.app.name)?.isBuilding ?? false,
    };
  }

  @Get()
  async list() {
    return (await this.apps.list()).map((v) => this.withBuilding(v));
  }

  @Post()
  create(@Body() body: unknown) {
    return this.apps.create(body as never);
  }

  /** What every running app uses now (shared for a few seconds). Declared before :name so it is not read as an app. */
  @Scope('read')
  @Get('usage')
  usageAll() {
    return this.apps.usageAllQuick();
  }

  @Get(':name')
  async get(@Param('name') name: string) {
    return this.withBuilding(await this.apps.get(name));
  }

  /** Which other apps name this one in their environment (by variable name only: the values are secrets) */
  @Get(':name/references')
  references(@Param('name') name: string) {
    return this.apps.referencesTo(name);
  }

  @Post(':name/rename')
  async rename(@Param('name') name: string, @Body() body: unknown) {
    const b = renameBody.parse(body);
    const done = await this.apps.rename(name, b.name, b);
    return {
      ...this.withBuilding(done.view),
      updated: done.updated,
      failed: done.failed,
    };
  }

  @Patch(':name')
  update(@Param('name') name: string, @Body() body: unknown) {
    return this.apps.update(name, body);
  }

  /**
   * For an app that keeps data on one machine: forgets which. Used when that machine is gone or being replaced; the data
   * is not moved. Admin only, like every change to an app.
   */
  @Post(':name/release-pin')
  @HttpCode(204)
  releasePin(@Param('name') name: string) {
    this.apps.releasePin(name);
  }

  @Delete(':name')
  remove(@Param('name') name: string) {
    return this.apps.remove(name);
  }

  /** Deploys an image and starts following the rollout (see GET :name/deployment) */
  @Scope('operate')
  @Post(':name/deploy')
  @HttpCode(202)
  async deploy(
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const image = deploy.parse(body).image;
    // An access token may roll an app to another release of the image it already runs, not run something else with
    // the app's secrets and data. Only a signed-in admin (or a deploy key) may change the image itself.
    if ((req as Request & { tokenScope?: string }).tokenScope)
      this.apps.assertSameImageRepository(name, image);
    const view = await this.apps.deploy(name, image);
    this.deployments.track(name, view.app.deployVersion, view.app.image);
    return viewFor(req, view);
  }

  @Scope('read')
  @Get(':name/deployment')
  deployment(@Param('name') name: string) {
    this.apps.getDefinition(name); // 404 for unknown apps
    return (
      this.deployments.get(name) ?? {
        app: name,
        isBuilding: false,
        isFailed: false,
        lines: [],
      }
    );
  }

  /**
   * How the app is set up, by name: its addresses, ports, the names of its variables and secrets, volumes, limits and
   * placement. Never a value (see app-config-view.ts). Read level, so a hub can show it without an admin token.
   */
  @Scope('read')
  @Get(':name/config')
  config(@Param('name') name: string) {
    return appConfigView(this.apps.getDefinition(name));
  }

  /**
   * What was deployed, newest first: the version, its image and when. Read level, since it holds no settings or
   * environment. The hub draws these on its charts and offers to roll back to one.
   */
  @Scope('read')
  @Get(':name/versions')
  versions(@Param('name') name: string) {
    const app = this.apps.getDefinition(name);
    return {
      current: app.deployVersion,
      versions: [...app.versions]
        .reverse()
        .slice(0, 20)
        .map((v) => ({
          version: v.version,
          image: v.image,
          deployedAt: v.deployedAt,
        })),
    };
  }

  /** The certificate the proxy serves for each of the app's addresses: issuer, expiry, or why there is none */
  @Scope('read')
  @Get(':name/certificates')
  certificates(@Param('name') name: string) {
    return this.apps.certificates(name);
  }

  /** What the app used over the last `minutes` (default 60, at most a day), as up to 120 averaged points */
  @Scope('read')
  @Get(':name/usage/history')
  usageOver(@Param('name') name: string, @Query('minutes') minutes?: string) {
    this.apps.getDefinition(name); // 404 for unknown apps
    const m = Number(minutes ?? 60);
    return {
      minutes: Number.isFinite(m) ? m : 60,
      points: this.usageHistory.history(name, Number.isFinite(m) ? m : 60),
    };
  }

  /** CPU and memory the running instances use right now, with the limits they were given */
  @Scope('read')
  @Get(':name/usage')
  usage(@Param('name') name: string) {
    return this.apps.usage(name);
  }

  /** Replaces the running instances with fresh ones (same image and settings) */
  @Scope('operate')
  @Post(':name/restart')
  @HttpCode(202)
  async restart(@Param('name') name: string, @Req() req: Request) {
    return viewFor(req, await this.apps.restart(name));
  }

  /** Starts a stopped app with one instance. Raise the count from the app's settings. */
  @Scope('operate')
  @Post(':name/start')
  @HttpCode(202)
  async start(@Param('name') name: string, @Req() req: Request) {
    const view = await this.apps.get(name);
    // Already running: leave the count alone rather than scale it down to one
    if (view.app.instanceCount > 0) return viewFor(req, view);
    return viewFor(req, await this.apps.update(name, { instanceCount: 1 }));
  }

  /** Scales the app to zero. Its settings and data stay; start brings it back. */
  @Scope('operate')
  @Post(':name/stop')
  @HttpCode(202)
  async stop(@Param('name') name: string, @Req() req: Request) {
    return viewFor(req, await this.apps.update(name, { instanceCount: 0 }));
  }

  /**
   * Runs the app on this many instances (1 to 20). To take it offline use stop. Everything else about the app stays
   * as it is, and the answer does not carry its settings.
   */
  @Scope('operate')
  @Post(':name/scale')
  @HttpCode(202)
  async scale(
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = scale.safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'Send { "instances": n } with a whole number from 1 to 20.',
      );
    return viewFor(
      req,
      await this.apps.update(name, { instanceCount: parsed.data.instances }),
    );
  }

  /** Re-applies the stored definition to Docker */
  @Scope('operate')
  @Post(':name/reconcile')
  async reconcile(@Param('name') name: string, @Req() req: Request) {
    return viewFor(req, await this.apps.reconcile(name));
  }
}
