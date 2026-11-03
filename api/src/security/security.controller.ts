import { Controller, Get, Query } from '@nestjs/common';
import { SecurityService } from './security.service';

@Controller('system/security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  /**
   * What the security check found, from the last scan unless it is older than a minute or `fresh=1` is given. Admin
   * only (no `@Scope`): it names where the weak spots are.
   */
  @Get()
  scan(@Query('fresh') fresh?: string, @Query('cached') cached?: string) {
    // `cached=1` only reads: an empty answer before the first scan, and never starts one
    if (cached === '1')
      return (
        this.security.latest() ?? { at: null, findings: [], hostChecked: false }
      );
    return this.security.scan(fresh === '1' || fresh === 'true');
  }
}
