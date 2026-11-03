import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { AccessTokensService } from './access-tokens.service';

const create = z.object({
  name: z.string().max(200),
  scope: z.enum(['read', 'operate', 'update']),
});

/** Management of access tokens. Signed-in admin only: no token can mint or list tokens. */
@Controller('system/access-tokens')
export class AccessTokensController {
  constructor(private readonly tokens: AccessTokensService) {}

  @Get()
  list() {
    return this.tokens.list();
  }

  /** The `token` in the response is the only time it is ever shown. */
  @Post()
  create(@Body() body: unknown) {
    const parsed = create.safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'Send { "name": "...", "scope": "read" | "operate" | "update" }.',
      );
    return this.tokens.create(parsed.data.name, parsed.data.scope);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@Param('id') id: string) {
    this.tokens.revoke(id);
  }
}
