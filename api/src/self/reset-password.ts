import bcrypt from 'bcryptjs';
import BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertValidNewPassword } from '../auth/password-rules';
import { ValidationError } from '../common/errors';

export interface ResetResult {
  password: string;
  /** True when the password was made here, so it has to be shown; false when the caller chose it */
  generated: boolean;
}

/**
 * Sets a new admin password straight in Provelox's database, for when the old one is lost. Works while the API runs
 * (settings are read from the database every time) or when it is down, and signs every session out by rotating the
 * token version, exactly as changing the password in the console does. It never creates a database: pointing it at
 * the wrong folder must not leave a second, empty platform behind.
 */
export function resetAdminPassword(
  dataDir: string,
  chosen?: string,
): ResetResult {
  const file = path.join(dataDir, 'provelox.db');
  if (!existsSync(file))
    throw new ValidationError(
      `No Provelox database in ${dataDir}. Mount the platform's data volume: -v pvx-provelox-data:${dataDir}`,
    );
  if (chosen !== undefined) assertValidNewPassword(chosen);
  const password = chosen ?? randomBytes(18).toString('base64url');

  const db = new BetterSqlite3(file, { fileMustExist: true });
  try {
    // The API may be writing at the same moment: wait for it instead of failing
    db.pragma('busy_timeout = 5000');
    const hasSettings = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'",
      )
      .get();
    if (!hasSettings)
      throw new ValidationError(
        `${file} is not a Provelox database (it has no settings).`,
      );
    const set = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    db.transaction(() => {
      set.run('passwordHash', JSON.stringify(bcrypt.hashSync(password, 10)));
      set.run('tokenVersion', JSON.stringify(randomBytes(16).toString('hex')));
    })();
  } finally {
    db.close();
  }
  return { password, generated: chosen === undefined };
}
