import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Scope } from '../auth/scope.decorator';
import { NotFoundError } from '../common/errors';
import { summarize, TEMPLATES, templateById } from './catalog';
import { TemplateSourcesService } from './template-sources.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly sources: TemplateSourcesService) {}

  /** The built-in templates, then those of the registries that were added (each saying which). */
  @Get()
  list() {
    return [
      ...TEMPLATES.map((t) => ({ ...summarize(t), source: null })),
      ...this.sources.all().map(summarize),
    ];
  }

  @Get('sources')
  listSources() {
    return this.sources.list();
  }

  /**
   * Makes a registry exist as described, adding or updating it by its address. For a hub that keeps the same template
   * registries on every node: its token needs the update scope, like the other fleet settings.
   */
  @Scope('update')
  @Put('sources/sync')
  syncSource(@Body() body: unknown) {
    return this.sources.upsert(body);
  }

  @Post('sources')
  addSource(@Body() body: unknown) {
    return this.sources.add(body);
  }

  @Post('sources/:id/refresh')
  refreshSource(@Param('id') id: string) {
    return this.sources.refresh(id);
  }

  @Delete('sources/:id')
  @HttpCode(204)
  removeSource(@Param('id') id: string) {
    this.sources.remove(id);
  }

  /** One template, including its compose file, to preview or deploy as a project. */
  @Get(':id')
  get(@Param('id') id: string) {
    const t = templateById(id) ?? this.sources.byId(id);
    if (!t) throw new NotFoundError('There is no such template.');
    return t;
  }
}
