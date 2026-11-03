import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

const login = z.object({ password: z.string().max(200) });
const change = z.object({
  oldPassword: z.string().max(200),
  newPassword: z.string().max(200),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: unknown, @Req() req: Request) {
    return this.auth.login(login.parse(body).password, Date.now(), req.ip);
  }

  @Post('change-password')
  changePassword(@Body() body: unknown) {
    const b = change.parse(body);
    return this.auth.changePassword(b.oldPassword, b.newPassword);
  }

  /** Cheap "is my token still good?" check for the console */
  @Get('me')
  me() {
    return { authenticated: true };
  }
}
