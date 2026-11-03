import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Scope } from '../auth/scope.decorator';
import { CertificatesService } from './certificates.service';

/** Why an address has no certificate, and a way to ask for one again. */
@Controller('apps')
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  /**
   * Whether the address has a certificate, and if not, why in words: HTTPS off, no Let's Encrypt email, DNS missing or
   * pointing elsewhere, or still waiting, with the proxy's own error when it logged one. Read level: it holds no settings.
   */
  @Scope('read')
  @Get(':name/domains/:host/diagnosis')
  diagnosis(@Param('name') name: string, @Param('host') host: string) {
    return this.certificates.diagnosis(name, host);
  }

  /**
   * Asks the proxy to try for the address's certificate again. Admin only, like every change to an app's domains, and
   * limited to one try a minute and three an hour so it cannot use up Let's Encrypt's limit on failed attempts.
   */
  @Post(':name/domains/:host/retry-certificate')
  @HttpCode(202)
  retry(@Param('name') name: string, @Param('host') host: string) {
    return this.certificates.retry(name, host);
  }
}
