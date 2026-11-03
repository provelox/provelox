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
import { z } from 'zod';
import { Scope } from '../auth/scope.decorator';
import { ValidationError } from '../common/errors';
import { NotificationsService } from './notifications.service';

const webhook = z
  .object({ name: z.string().max(60), url: z.string().max(2000) })
  .strict();
const events = z
  .object({
    problem: z.boolean(),
    recovered: z.boolean(),
    certificate: z.boolean(),
  })
  .partial()
  .strict();

@Controller('system/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** The webhooks (their hosts only) and which events are sent */
  @Get()
  get() {
    return this.notifications.view();
  }

  @Put('events')
  setEvents(@Body() body: unknown) {
    const parsed = events.safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'problem, recovered and certificate must each be true or false.',
      );
    return this.notifications.setEvents(parsed.data);
  }

  /**
   * Sets webhooks (by name) and events in one go: what a hub sends to every node. Needs the update scope, like the
   * other settings a hub keeps the same. Webhooks a node already has are left alone.
   */
  @Scope('update')
  @Put('sync')
  sync(@Body() body: unknown) {
    const parsed = z
      .object({
        events: events.optional(),
        webhooks: z.array(webhook).max(10).optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        'Send { "events": { problem, recovered, certificate }, "webhooks": [{ "name", "url" }] }.',
      );
    return this.notifications.sync(parsed.data);
  }

  @Post('webhooks')
  addWebhook(@Body() body: unknown) {
    const parsed = webhook.safeParse(body);
    if (!parsed.success)
      throw new ValidationError('A webhook needs a name and an address.');
    return this.notifications.addWebhook(parsed.data.name, parsed.data.url);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  removeWebhook(@Param('id') id: string) {
    this.notifications.removeWebhook(id);
  }

  /** Sends a sample message to a webhook */
  @Post('webhooks/:id/test')
  @HttpCode(200)
  test(@Param('id') id: string) {
    return this.notifications.test(id);
  }
}
