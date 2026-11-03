import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { Scope } from '../auth/scope.decorator';
import { RegistriesService } from './registries.service';

@Controller('registries')
export class RegistriesController {
  constructor(private readonly registries: RegistriesService) {}

  @Get()
  list() {
    return this.registries.list();
  }

  @Post()
  add(@Body() body: unknown) {
    return this.registries.add(body);
  }

  /**
   * Sets the sign-in for a registry, adding it or replacing the one there. For a hub that keeps sign-ins the same on
   * every node: its token needs the update scope, like the other fleet settings.
   */
  @Scope('update')
  @Put('signin')
  upsert(@Body() body: unknown) {
    return this.registries.upsert(body);
  }

  /** Whether the saved sign-in lets this server pull an image. Pulls nothing. */
  @Post('check')
  @HttpCode(200)
  check(@Body() body: unknown) {
    return this.registries.check(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.registries.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    this.registries.remove(id);
  }
}
