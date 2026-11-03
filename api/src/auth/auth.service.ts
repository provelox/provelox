import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import {
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { CONFIG, type Config } from '../config/config';
import { SettingsService } from '../system/settings.service';
import { assertValidNewPassword } from './password-rules';

export { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from './password-rules';

const FAILURE_WINDOW_MS = 30_000;
const MAX_FAILURES = 5;
/** Across every client: stops a guesser who keeps changing address, without letting one client lock everyone else out */
const MAX_FAILURES_ALL = 40;
const MAX_TRACKED = 2000;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger('Auth');
  /** Wrong passwords per client address, within the window */
  private failures = new Map<string, number[]>();
  private allFailures: number[] = [];

  constructor(
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** First start: set the admin password from the environment, or generate one and say so once. */
  onModuleInit() {
    if (this.settings.get<string>('passwordHash')) return;
    const generated = !this.cfg.ADMIN_PASSWORD;
    const password =
      this.cfg.ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
    this.settings.set('passwordHash', bcrypt.hashSync(password, 10));
    this.settings.set('tokenVersion', randomBytes(16).toString('hex'));
    if (generated)
      this.log.warn(
        `No ADMIN_PASSWORD was set. The admin password is: ${password}  (shown once, change it after signing in)`,
      );
    else this.log.log('Admin password set from ADMIN_PASSWORD.');
  }

  private tokenVersion() {
    return this.settings.get<string>('tokenVersion') ?? '';
  }

  private sign() {
    return jwt.sign({ tv: this.tokenVersion() }, this.cfg.JWT_SECRET, {
      expiresIn: `${this.cfg.SESSION_HOURS}h`,
      subject: 'admin',
    });
  }

  login(
    password: string,
    now = Date.now(),
    ip = 'unknown',
  ): { token: string; expiresInHours: number } {
    const recent = (this.failures.get(ip) ?? []).filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    );
    this.allFailures = this.allFailures.filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    );
    if (
      recent.length >= MAX_FAILURES ||
      this.allFailures.length >= MAX_FAILURES_ALL
    )
      throw new TooManyRequestsError(
        'Too many wrong passwords. Wait 30 seconds and try again.',
      );
    const hash = this.settings.get<string>('passwordHash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      recent.push(now);
      this.allFailures.push(now);
      if (!this.failures.has(ip) && this.failures.size >= MAX_TRACKED)
        this.failures.clear();
      this.failures.set(ip, recent);
      // the same message for every failure: nothing to learn about what was wrong
      throw new UnauthorizedError('Invalid credentials');
    }
    this.failures.delete(ip);
    return { token: this.sign(), expiresInHours: this.cfg.SESSION_HOURS };
  }

  verify(token: string): void {
    try {
      const payload = jwt.verify(token, this.cfg.JWT_SECRET) as { tv?: string };
      if (payload.tv !== this.tokenVersion()) throw new Error('stale');
    } catch {
      throw new UnauthorizedError('Session expired, sign in again');
    }
  }

  /** Changing the password signs everyone out (the token version rotates) and returns a fresh token. */
  changePassword(oldPassword: string, newPassword: string): { token: string } {
    const hash = this.settings.get<string>('passwordHash') as string;
    if (!bcrypt.compareSync(oldPassword ?? '', hash))
      throw new UnauthorizedError('Old password is incorrect.');
    assertValidNewPassword(newPassword);
    if (newPassword === oldPassword)
      throw new ValidationError(
        'The new password must be different from the old one.',
      );
    this.settings.set('passwordHash', bcrypt.hashSync(newPassword, 10));
    this.settings.set('tokenVersion', randomBytes(16).toString('hex'));
    return { token: this.sign() };
  }
}
