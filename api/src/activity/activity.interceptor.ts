import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { actorOf } from './actor';
import { describeRequest } from './activity.describe';
import { ActivityService } from './activity.service';

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records every change someone makes. It listens for the end of the response, so what is logged is what was really
 * answered (a refused change is logged as failed, with its status), and it does its work after the answer has gone.
 * Requests with no known actor (a failed sign-in, a bad deploy key) are not events: they never got in.
 */
@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    if (!CHANGES.has(req.method)) return next.handle();
    const res = http.getResponse<Response>();
    res.once('finish', () =>
      setImmediate(() => {
        try {
          const actor = actorOf(req);
          const route = (req.route?.path as string | undefined)?.replace(
            /^\/v\d+/,
            '',
          );
          if (!actor || !route) return;
          const what = describeRequest(
            req.method,
            route,
            req.params as Record<string, string>,
            req.body,
          );
          if (!what) return;
          this.activity.record({
            actor,
            action: what.action,
            // A deploy key can only deploy the app it belongs to: that app is the target
            target: what.target ?? actor.app ?? null,
            outcome: res.statusCode < 400 ? 'ok' : 'failed',
            status: res.statusCode,
            summary: what.summary,
          });
        } catch {
          // logging is never allowed to matter
        }
      }),
    );
    return next.handle();
  }
}
