import {
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { isValidName } from '../common/naming';
import { brandPage } from '../pages/brand-pages';
import { SettingsService } from '../system/settings.service';
import { AppsRepo } from './apps.repo';

const STATUSES = ['502', '503', '504'];

/**
 * Serves the pages Traefik shows when an app cannot answer (its errors middleware fetches
 * /internal/error-pages/<app>/<status>). Public on purpose: only the proxy calls it, and it returns nothing but
 * the HTML the app owner chose to show every visitor.
 */
/**
 * These pages are written by whoever may set them and are shown at every app's address, so they run with no script and
 * no way to reach the address's own data or forms: they are styled pages, nothing more.
 */
const PAGE_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:";

@Controller({ path: 'internal/error-pages', version: VERSION_NEUTRAL })
export class ErrorPagesController {
  constructor(
    private readonly repo: AppsRepo,
    private readonly settings: SettingsService,
  ) {}

  /** What the proxy shows for an address no app answers to. Answers 404, so crawlers and checks see the truth. */
  @Public()
  @Get('not-found')
  @HttpCode(404)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', PAGE_CSP)
  @Header('X-Content-Type-Options', 'nosniff')
  notFound() {
    return this.settings.errorPages()['404'] || brandPage('404');
  }

  @Public()
  @Get(':app/:status')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', PAGE_CSP)
  @Header('X-Content-Type-Options', 'nosniff')
  page(@Param('app') app: string, @Param('status') status: string) {
    if (!STATUSES.includes(status)) throw new NotFoundException();
    const s = status as '502' | '503' | '504';
    // The same answer for an app that does not exist as for one that has no page of its own: this address is public, so
    // it must not say which apps there are
    const found = isValidName(app) ? this.repo.get(app) : undefined;
    // the app's own page, else the platform's (set once for a whole fleet), else the built-in one
    return (
      found?.errorPages[s] || this.settings.errorPages()[s] || brandPage(s)
    );
  }
}
