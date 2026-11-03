import bcrypt from 'bcryptjs';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthService } from '../auth/auth.service';
import { ValidationError } from '../common/errors';
import type { Config } from '../config/config';
import { Db } from '../db/db';
import { SettingsService } from '../system/settings.service';
import { resetAdminPassword } from './reset-password';

const cfg = { JWT_SECRET: 'x'.repeat(40), SESSION_HOURS: 8 } as Config;

/** A platform whose database lives in a real folder, as in the data volume */
function platform(adminPassword = 'old-password-1') {
  const dir = mkdtempSync(path.join(tmpdir(), 'pvx-reset-'));
  const db = new Db(dir);
  const settings = new SettingsService(db, cfg);
  settings.set('passwordHash', bcrypt.hashSync(adminPassword, 4));
  settings.set('tokenVersion', 'old-version');
  return { dir, db, settings, auth: new AuthService(settings, cfg) };
}

describe('resetAdminPassword', () => {
  const dirs: string[] = [];
  afterEach(() =>
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
  );
  const make = (pw?: string) => {
    const p = platform(pw);
    dirs.push(p.dir);
    return p;
  };

  it('makes a password the platform then accepts, and refuses the old one', () => {
    const p = make();
    const r = resetAdminPassword(p.dir);
    expect(r.generated).toBe(true);
    expect(r.password.length).toBeGreaterThanOrEqual(20);
    // the running API reads the same database
    expect(p.auth.login(r.password).token).toBeTruthy();
    expect(() => p.auth.login('old-password-1')).toThrow('Invalid credentials');
  });

  it('signs out every existing session', () => {
    const p = make();
    const { token } = p.auth.login('old-password-1');
    expect(() => p.auth.verify(token)).not.toThrow();
    resetAdminPassword(p.dir);
    expect(() => p.auth.verify(token)).toThrow(/Session expired/);
  });

  it('uses the password it is given, and does not hand it back as generated', () => {
    const p = make();
    const r = resetAdminPassword(p.dir, 'my-chosen-secret');
    expect(r.generated).toBe(false);
    expect(p.auth.login('my-chosen-secret').token).toBeTruthy();
  });

  it('applies the same rules as changing the password in the console', () => {
    const p = make();
    expect(() => resetAdminPassword(p.dir, 'short')).toThrow(/at least 8/);
    expect(() => resetAdminPassword(p.dir, 'x'.repeat(73))).toThrow(
      /at most 72/,
    );
    // a refused password changes nothing
    expect(p.auth.login('old-password-1').token).toBeTruthy();
  });

  it('never creates a database: a wrong folder is an error, and stays empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pvx-empty-'));
    dirs.push(dir);
    expect(() => resetAdminPassword(dir)).toThrow(/No Provelox database/);
    expect(() => resetAdminPassword(dir)).toThrow(ValidationError);
    expect(existsSync(path.join(dir, 'provelox.db'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a database that is not Provelox's", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pvx-other-'));
    dirs.push(dir);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const other = new (require('better-sqlite3'))(
      path.join(dir, 'provelox.db'),
    );
    other.exec('CREATE TABLE unrelated (x)');
    other.close();
    expect(() => resetAdminPassword(dir)).toThrow(/not a Provelox database/);
  });

  it('works while the API holds the database open', () => {
    const p = make();
    // p.db stays open, as in a running API
    const r = resetAdminPassword(p.dir);
    expect(p.auth.login(r.password).token).toBeTruthy();
    p.db.close();
  });
});
