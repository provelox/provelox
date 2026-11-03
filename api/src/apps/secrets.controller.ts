import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { SecretsService } from './secrets.service';

const body = z.object({ value: z.string() });

/** Values can be written and replaced, never read back: listing returns names only. */
@Controller('apps/:name/secrets')
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  list(@Param('name') name: string) {
    return this.secrets.list(name);
  }

  @Put(':secret')
  set(
    @Param('name') name: string,
    @Param('secret') secret: string,
    @Body() b: unknown,
  ) {
    const parsed = body.safeParse(b);
    if (!parsed.success)
      throw new ValidationError('Send the value as { "value": "..." }.');
    return this.secrets.set(name, secret, parsed.data.value);
  }

  @Delete(':secret')
  remove(@Param('name') name: string, @Param('secret') secret: string) {
    return this.secrets.remove(name, secret);
  }
}
