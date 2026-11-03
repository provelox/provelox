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
import { CdnService } from './cdn.service';

/** The CDNs apps can sit behind, and their address ranges. Changing one needs a signed-in admin. */
@Controller('cdn')
export class CdnController {
  constructor(private readonly cdn: CdnService) {}

  @Scope('read')
  @Get()
  list() {
    return { providers: this.cdn.view() };
  }

  /** Fetches the ranges again now (they are refreshed on a schedule anyway) */
  @Post('refresh')
  @HttpCode(200)
  async refresh() {
    const result = await this.cdn.refreshAll();
    return { ...result, providers: this.cdn.view() };
  }

  /** Adds or replaces a CDN Provelox does not know: its ranges from an address, or listed by hand */
  @Put('providers/:id')
  save(@Param('id') id: string, @Body() body: unknown) {
    return this.cdn.saveCustom(id, body);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.cdn.removeCustom(id);
  }
}
