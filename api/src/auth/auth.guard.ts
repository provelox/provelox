import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { setActor } from '../activity/actor';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { AccessTokensService, TOKEN_PREFIX } from './access-tokens.service';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './public.decorator';
import { TOKEN_SCOPE, scopeAllows, type TokenScope } from './scope.decorator';

/** Everything requires a valid bearer token unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly tokens: AccessTokensService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token)
      throw new UnauthorizedError();
    if (token.startsWith(TOKEN_PREFIX)) {
      const held = this.tokens.authenticate(token, req.ip ?? 'unknown');
      // So a route can say what the caller may do, without asking the token store again
      (req as Request & { tokenScope?: TokenScope }).tokenScope = held.scope;
      // Who is asking, for the activity log (the name, never the token)
      setActor(req, { kind: 'token', name: held.name, scope: held.scope });
      const needed = this.reflector.getAllAndOverride<TokenScope | undefined>(
        TOKEN_SCOPE,
        [ctx.getHandler(), ctx.getClass()],
      );
      // Closed unless the route says otherwise. A read token never operates, and only an update token updates.
      if (!needed || !scopeAllows(held.scope, needed))
        throw new ForbiddenError();
      return true;
    }
    this.auth.verify(token);
    setActor(req, { kind: 'admin', name: 'admin' });
    return true;
  }
}
