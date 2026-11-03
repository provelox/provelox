import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ProjectsService } from './projects.service';

const named = z.object({ name: z.string().max(60) }).passthrough();

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  /** Shows what a compose file would do. Changes nothing. */
  @Post('preview')
  preview(@Body() body: unknown) {
    const { name } = named.parse(body);
    return this.projects.preview(name, body);
  }

  @Post()
  deploy(@Body() body: unknown) {
    const { name } = named.parse(body);
    return this.projects.deploy(name, body);
  }

  /** A new project's compose file made from apps that already run, to review. Deploys nothing. */
  @Post('from-apps')
  fromApps(@Body() body: unknown) {
    return this.projects.groupApps(null, (body as { apps?: unknown })?.apps);
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.projects.get(name);
  }

  /** The project's compose file with a template's services added, to review. Deploys nothing. */
  @Post(':name/add-template')
  addTemplate(@Param('name') name: string, @Body() body: unknown) {
    return this.projects.addTemplate(
      name,
      (body as { template?: unknown })?.template,
    );
  }

  /** The project's compose file with apps that already run added as services, to review. Deploys nothing. */
  @Post(':name/add-apps')
  addApps(@Param('name') name: string, @Body() body: unknown) {
    return this.projects.groupApps(name, (body as { apps?: unknown })?.apps);
  }

  /** The project's compose file with one more service, to review. Deploys nothing. */
  @Post(':name/add-service')
  addService(@Param('name') name: string, @Body() body: unknown) {
    return this.projects.addService(name, body);
  }

  /** Bring an existing project in line with a new compose file */
  @Put(':name')
  update(@Param('name') name: string, @Body() body: unknown) {
    return this.projects.deploy(name, body);
  }

  @Delete(':name')
  /** `?deleteVolumes=true` also deletes the project's data volumes. Without it they are kept. */
  remove(
    @Param('name') name: string,
    @Query('deleteVolumes') deleteVolumes?: string,
  ) {
    return this.projects.remove(name, {
      deleteVolumes: deleteVolumes === 'true',
    });
  }
}
