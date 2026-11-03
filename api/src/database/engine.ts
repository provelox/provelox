/**
 * What kind of database an app runs, and what a dump file is. Pure functions: the service only gathers the facts
 * (the image, which tools exist in the container, the first bytes of an upload) and these decide.
 */

/** The engines Provelox can dump and restore. MongoDB and Redis are meant to be added here, each with its own script. */
export type Engine = 'postgres' | 'mysql' | 'mariadb';

/** The programs an engine's dump and restore use, as they are called inside the container */
export const ENGINE_TOOLS: Record<Engine, string[]> = {
  postgres: ['pg_dump', 'pg_dumpall', 'pg_restore', 'psql'],
  // mysqldump/mysql, or mariadb-dump/mariadb where the image only has those (MariaDB 11 no longer ships the old names)
  mysql: ['mysqldump|mariadb-dump', 'mysql|mariadb'],
  mariadb: ['mysqldump|mariadb-dump', 'mysql|mariadb'],
};

/** What the image's name says. `generic` is a name like "img-captain-database": a database, but of which kind is open. */
export type NameHint = Engine | 'generic' | null;

/** The last two parts of the repository name, lowercase, without registry or tag. */
function repoName(image: string): string {
  const repo = image.split('@')[0].replace(/:[^/:]*$/, '');
  return repo.split('/').slice(-2).join('/').toLowerCase();
}

/**
 * Judged by the repository name only, never the tag. `postgres`, `postgis`, `timescaledb` are PostgreSQL; `mariadb` is
 * MariaDB; `mysql` and `percona` are MySQL; any other name that is, or ends in, "db" or "database" is a database of an
 * unknown kind, which the tools found inside the container then settle.
 */
export function nameHint(image: string | undefined): NameHint {
  if (!image) return null;
  const name = repoName(image);
  if (/(postgres|postgis|timescale|pgvector)/.test(name)) return 'postgres';
  if (/mariadb/.test(name)) return 'mariadb';
  if (/(mysql|percona)/.test(name)) return 'mysql';
  if (/(^|[/_.-])(db|database)([/_.-]|$)/.test(name)) return 'generic';
  return null;
}

/**
 * The engine from what the image is called and which tools the running container has (`found` is the names of the
 * programs it holds, from a fixed probe). The tool is the proof: a name alone never makes an app a database.
 */
export function chooseEngine(
  hint: NameHint,
  found: string[],
):
  | { engine: Engine; canBackup: true }
  | { engine: Engine | null; canBackup: false; reason: string } {
  if (hint === null) return { engine: null, canBackup: false, reason: '' };
  const has = (t: string) => t.split('|').some((x) => found.includes(x));
  const pg = ENGINE_TOOLS.postgres.every(has);
  const my = ENGINE_TOOLS.mysql.every(has);
  const mariaOnly =
    found.includes('mariadb-dump') && !found.includes('mysqldump');

  if (hint === 'postgres')
    return pg
      ? { engine: 'postgres', canBackup: true }
      : {
          engine: 'postgres',
          canBackup: false,
          reason:
            'This looks like PostgreSQL, but its image does not contain pg_dump, pg_restore and psql, so Provelox cannot use them. Dump it from your own tooling.',
        };
  if (hint === 'mysql' || hint === 'mariadb') {
    const engine: Engine =
      hint === 'mariadb' || mariaOnly ? 'mariadb' : 'mysql';
    return my
      ? { engine, canBackup: true }
      : {
          engine,
          canBackup: false,
          reason: `This looks like ${engine === 'mariadb' ? 'MariaDB' : 'MySQL'}, but its image does not contain mysqldump and mysql (or mariadb-dump and mariadb), so Provelox cannot use them.`,
        };
  }
  // generic name: decided by the tools alone, and only when they say one thing
  if (pg && !my) return { engine: 'postgres', canBackup: true };
  if (my && !pg)
    return { engine: mariaOnly ? 'mariadb' : 'mysql', canBackup: true };
  return {
    engine: null,
    canBackup: false,
    reason:
      pg && my
        ? 'The image has the tools of more than one database, so Provelox cannot tell which one the app runs.'
        : 'The image is named like a database, but it has none of the dump tools Provelox knows (PostgreSQL, MySQL, MariaDB).',
  };
}

/** What a restore file turned out to be */
export type DumpFormat =
  /** PostgreSQL's custom format (pg_dump -Fc) */
  | 'pg-custom'
  /** SQL text, with what its first lines say about where it came from */
  | { sql: { from: Engine | 'unknown'; all: boolean } }
  | 'gzip'
  | 'binary';

const MAGIC_PG = Buffer.from('PGDMP');

/**
 * What the first bytes of a file are. Gzip is only reported (the caller unpacks it and looks again); a custom-format
 * dump is told by its magic; text is SQL when it holds no NUL bytes, and says which engine wrote it when its header
 * does (mysqldump, mariadb-dump, pg_dump and pg_dumpall all start with a comment naming themselves).
 */
export function detectFormat(head: Buffer): DumpFormat {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.subarray(0, MAGIC_PG.length).equals(MAGIC_PG)) return 'pg-custom';
  if (head.length === 0 || head.includes(0)) return 'binary';
  const text = head.toString('utf8');
  let from: Engine | 'unknown' = 'unknown';
  if (/^--\s*MariaDB dump|\/\*M!/m.test(text)) from = 'mariadb';
  else if (/^--\s*MySQL dump/m.test(text)) from = 'mysql';
  else if (/^--\s*PostgreSQL database (dump|cluster dump)/m.test(text))
    from = 'postgres';
  const all =
    /^--\s*PostgreSQL database cluster dump/m.test(text) ||
    /^--\s*Current Database:/m.test(text) ||
    /^\s*CREATE DATABASE\b/im.test(text);
  return { sql: { from, all } };
}

/** Whether a file written by `from` can be fed to `engine`. MySQL and MariaDB read each other's plain SQL. */
export function compatible(engine: Engine, from: Engine | 'unknown'): boolean {
  if (from === 'unknown') return true;
  if (engine === 'postgres') return from === 'postgres';
  return from === 'mysql' || from === 'mariadb';
}

/** A file name for a dump: the app, the time in UTC, and what kind of file it is */
export function dumpFilename(
  app: string,
  now: Date,
  kind: 'custom' | 'sql',
): string {
  const slug = app.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const t = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d+Z$/, '');
  return `${slug}-${t}.${kind === 'custom' ? 'dump' : 'sql.gz'}`;
}
