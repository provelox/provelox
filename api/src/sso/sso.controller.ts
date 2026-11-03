import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppsRepo } from '../apps/apps.repo';
import { Public } from '../auth/public.decorator';
import { Scope } from '../auth/scope.decorator';
import { isValidName } from '../common/naming';
import { ValidationError } from '../common/errors';
import { ssoPage } from './sso.pages';
import { NONCE_COOKIE, SESSION_COOKIE, SsoService } from './sso.service';

/** The identity providers apps can ask visitors to sign in with. Changing one needs a signed-in admin. */
@Controller('sso')
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  @Scope('read')
  @Get()
  list() {
    return {
      available: this.sso.available(),
      redirectUri: this.sso.redirectUri(),
      providers: this.sso.list(),
    };
  }

  /** Adds a provider (a new id is made from its label) or replaces one */
  @Put('providers/:id')
  save(@Param('id') id: string, @Body() body: unknown) {
    return this.sso.save(id, body);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    this.sso.remove(id);
  }
}

const cookies = (req: Request): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

const header = (req: Request, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() ?? '';
};

const cookie = (name: string, value: string, maxAge: number, https: boolean) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;

/**
 * What the proxy and the visitor's browser call during a sign-in. Public on purpose: it is how someone who is not signed
 * in gets to sign in. Each answer is built only from the sealed values this server made.
 */
@Controller({ path: 'internal/sso', version: VERSION_NEUTRAL })
export class SsoPublicController {
  constructor(
    private readonly sso: SsoService,
    private readonly repo: AppsRepo,
  ) {}

  private app(name: string) {
    const app = isValidName(name) ? this.repo.get(name) : undefined;
    return app?.sso ? app : undefined;
  }

  /**
   * The proxy asks this for every request to a protected app (forward auth). 200 lets it through and names the visitor;
   * anything else is shown to the visitor as it is: a redirect to sign in for a page load, 401 for everything else.
   */
  @Public()
  @Get('verify/:app')
  verify(
    @Param('app') name: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const app = this.app(name);
    // Closed, not open, when the app is gone or no longer asks for a sign-in: the proxy would not be asking otherwise
    if (!app) return res.status(403).end();
    const who = this.sso.check(app, cookies(req)[SESSION_COOKIE]);
    if (who) {
      res.setHeader('X-Provelox-User', who.name.replace(/[\r\n]/g, ' '));
      res.setHeader('X-Provelox-Email', who.email);
      return res.status(200).end();
    }
    const host = header(req, 'x-forwarded-host');
    const proto =
      header(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http';
    const navigates =
      header(req, 'x-forwarded-method').toUpperCase() === 'GET' &&
      (req.headers.accept ?? '').includes('text/html');
    if (!navigates || !this.sso.ownsHost(app, host))
      return res.status(401).json({ message: 'Sign in required' });
    const rd = encodeURIComponent(header(req, 'x-forwarded-uri') || '/');
    return res.redirect(302, `${proto}://${host}/.pvx-auth/login?rd=${rd}`);
  }

  /** Step 1, at the app's address: remember this browser, then go to the provider */
  @Public()
  @Get('app/:app/login')
  async login(
    @Param('app') name: string,
    @Query('rd') rd: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const app = this.app(name);
    if (!app)
      return res.status(404).send(ssoPage('Not found', 'Nothing here.'));
    const proto =
      header(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http';
    const { url, nonce } = await this.sso.start(
      app,
      header(req, 'x-forwarded-host'),
      proto,
      rd,
    );
    res.setHeader(
      'Set-Cookie',
      cookie(NONCE_COOKIE, nonce, 600, proto === 'https'),
    );
    return res.redirect(302, url);
  }

  /** Step 2, at the API's address: the provider sends the visitor back here with a code */
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    if (error || !code || !state)
      return res
        .status(400)
        .send(
          ssoPage(
            'Sign-in cancelled',
            'The sign-in did not complete. Open the app again to try once more.',
          ),
        );
    const r = await this.sso.callback(code, state);
    if (r.ok) return res.redirect(302, r.url);
    return res
      .status(403)
      .send(
        ssoPage(
          'Not allowed',
          `${r.email} is not allowed to open this app. Ask whoever runs it to add you, or sign in with another account.`,
        ),
      );
  }

  /** Step 3, back at the app's address: the cookie is set here, so it belongs to this address only */
  @Public()
  @Get('app/:app/finish')
  finish(
    @Param('app') name: string,
    @Query('t') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const app = this.app(name);
    if (!app)
      return res.status(404).send(ssoPage('Not found', 'Nothing here.'));
    if (typeof token !== 'string') throw new ValidationError('Missing token');
    const done = this.sso.finish(name, token, cookies(req)[NONCE_COOKIE]);
    const https = header(req, 'x-forwarded-proto') === 'https';
    res.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, done.cookie, done.maxAge, https),
      cookie(NONCE_COOKIE, '', 0, https),
    ]);
    return res.redirect(302, done.rd);
  }

  @Public()
  @Get('app/:app/logout')
  logout(
    @Param('app') name: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const https = header(req, 'x-forwarded-proto') === 'https';
    res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', 0, https));
    return res.redirect(302, '/');
  }
}
