import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { DomainError, ValidationError } from './errors';

/** One error shape for every failure: { error: { code, message, details? } }. Internals never leak. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const send = (
      status: number,
      code: string,
      message: string,
      details?: unknown,
    ) => {
      // The only record of a request that failed: what was asked and why it was refused (never the body, which can hold
      // secrets). Without it a refused call leaves nothing in the logs. Not found and signed-out calls are everyday noise.
      if (status >= 400 && status !== 401 && status !== 404)
        this.log.warn(`${req?.method} ${req?.path} -> ${status} ${message}`);
      return res.status(status).json({
        error: {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
        },
      });
    };

    if (exception instanceof ValidationError)
      return send(400, exception.code, exception.message, exception.details);
    if (exception instanceof DomainError)
      return send(exception.status, exception.code, exception.message);
    if (exception instanceof ZodError)
      return send(
        400,
        'invalid',
        exception.issues[0]?.message ?? 'Invalid input',
        exception.issues,
      );
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string }).message ?? exception.message);
      return send(
        status,
        status === 404 ? 'not_found' : 'http_error',
        Array.isArray(message) ? message.join(', ') : message,
      );
    }
    // Errors from the body parser and the like carry their own client-error status (malformed JSON, a body too large):
    // answer with it, without a stack trace in the log for every bad request an anonymous caller can send
    const e = exception as {
      status?: unknown;
      statusCode?: unknown;
      type?: unknown;
    };
    const clientStatus = Number(e?.status ?? e?.statusCode);
    if (
      Number.isInteger(clientStatus) &&
      clientStatus >= 400 &&
      clientStatus < 500
    )
      return send(
        clientStatus,
        clientStatus === 413 ? 'too_large' : 'bad_request',
        clientStatus === 413
          ? 'The request body is too large.'
          : 'The request could not be read.',
      );
    this.log.error(
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : String(exception),
    );
    return send(500, 'internal', 'Something went wrong on the server.');
  }
}
