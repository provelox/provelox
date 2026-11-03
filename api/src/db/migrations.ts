/** Append only: a released migration must never change. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE apps (name TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
  CREATE TABLE projects (name TEXT PRIMARY KEY, compose TEXT NOT NULL, variable_names TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  `
  CREATE TABLE registries (id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, username TEXT NOT NULL, sealed_password TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE ci_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, app TEXT NOT NULL, secret_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, last_used_image TEXT);
  CREATE INDEX ci_keys_app ON ci_keys (app);
  `,
  `
  CREATE TABLE usage_samples (app TEXT NOT NULL, at INTEGER NOT NULL, cpu REAL NOT NULL, mem INTEGER NOT NULL);
  CREATE INDEX usage_samples_app_at ON usage_samples (app, at);
  `,
  `
  CREATE TABLE access_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, secret_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
  `,
  `
  CREATE TABLE template_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL UNIQUE, ref TEXT, path TEXT, sealed_token TEXT, created_at TEXT NOT NULL, synced_at TEXT, error TEXT, cache TEXT NOT NULL DEFAULT '[]', skipped TEXT NOT NULL DEFAULT '[]');
  `,
  `
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_scope TEXT,
    actor_app TEXT,
    action TEXT NOT NULL,
    target TEXT,
    outcome TEXT NOT NULL,
    status INTEGER NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE INDEX activity_target ON activity (target, id);
  CREATE INDEX activity_at ON activity (at);
  `,
];
