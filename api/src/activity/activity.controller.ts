import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import { ActivityService } from './activity.service';

const query = z
  .object({
    app: z.string().trim().max(80).optional(),
    action: z
      .string()
      .trim()
      .max(60)
      .regex(/^[a-z0-9.-]+$/, 'Use an action such as app or app.deploy')
      .optional(),
    actor: z.string().trim().max(80).optional(),
    outcome: z.enum(['ok', 'failed']).optional(),
    since: z.string().datetime().optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * The activity log. Admin only, on purpose: it has no @Scope, so no access token can read it (the hub's included). It
 * says who did what, and that is for the person who signs in.
 */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(@Query() raw: unknown) {
    const parsed = query.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid filter',
      );
    return {
      ...this.activity.list(parsed.data),
      actors: this.activity.actors(),
    };
  }
}
