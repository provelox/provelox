import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

/** A thin wrapper so the rest of the code never imports the SQLite driver directly. */
export class Db {
  readonly raw: BetterSqlite3.Database;

  /** `:memory:` for tests, otherwise a file inside `dataDir`. */
  constructor(dataDir: string | ':memory:') {
    if (dataDir === ':memory:') this.raw = new BetterSqlite3(':memory:');
    else {
      mkdirSync(dataDir, { recursive: true });
      this.raw = new BetterSqlite3(path.join(dataDir, 'provelox.db'));
      this.raw.pragma('journal_mode = WAL');
    }
    this.raw.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)',
    );
    const row = this.raw.prepare('SELECT version FROM schema_version').get() as
      { version: number } | undefined;
    let current = row?.version ?? 0;
    if (!row)
      this.raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.transaction(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.prepare('UPDATE schema_version SET version = ?').run(v + 1);
      })();
      current = v + 1;
    }
  }

  close() {
    this.raw.close();
  }
}
