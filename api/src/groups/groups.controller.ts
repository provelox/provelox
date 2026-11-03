import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { GroupsService } from './groups.service';

const body = z.object({ name: z.string().max(200) });

@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list() {
    return this.groups.list();
  }

  @Post()
  create(@Body() b: unknown) {
    return this.groups.create(body.parse(b).name);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() b: unknown) {
    return this.groups.rename(id, body.parse(b).name);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    this.groups.remove(id);
  }
}
