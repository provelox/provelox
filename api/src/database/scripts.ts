/**
 * The programs run inside the app's own container, as FIXED text. Nothing a person typed, no setting and no secret is
 * ever put into this text: the script is started as `sh -c <script> sh <mode>`, where the mode is one word chosen from the
 * lists below by the API. The database's own credentials are read by the script from the container's environment (a
 * value, or the file named by the same name with `_FILE`, as the official images do) and never leave it: they are not on
 * a command line, not in the output, not in a log.
 */

/** Reads a setting of the container's environment: NAME, or the contents of the file NAME_FILE points to. */
const READ_SETTING = `
val() {
  v=$(printenv "$1" 2>/dev/null) || v=
  if [ -z "$v" ]; then
    f=$(printenv "$1_FILE" 2>/dev/null) || f=
    if [ -n "$f" ] && [ -r "$f" ]; then v=$(cat "$f"); fi
  fi
  printf %s "$v"
}
`;

export const POSTGRES_MODES = [
  'dump-custom',
  'dump-all',
  'restore-custom',
  'restore-custom-clean',
  'restore-sql',
  'restore-sql-clean',
] as const;
export type PostgresMode = (typeof POSTGRES_MODES)[number];

/**
 * PostgreSQL. The official image trusts connections over its local socket, so the password is only used when one is set
 * (PGPASSWORD, from the container's own environment). Restoring takes `--no-owner --no-acl`: a dump from another server
 * names roles that may not exist here, and restoring as the database's own user would fail on every one of them.
 * `--exit-on-error` and ON_ERROR_STOP make a restore stop at the first problem instead of finishing half of it quietly.
 * "Replace" first drops every schema of the database that is not the server's own and makes `public` again, so what the
 * dump does not hold is gone too (pg_restore --clean alone only drops what the dump names).
 */
export const POSTGRES_SCRIPT = `set -e
${READ_SETTING}
RESET="DO \\$\\$ DECLARE s text; BEGIN FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP; CREATE SCHEMA public; END \\$\\$"
reset() { psql -U "$U" -d "$D" -X -q -v ON_ERROR_STOP=1 -c "$RESET" </dev/null; }
U=$(val POSTGRES_USER); [ -n "$U" ] || U=postgres
D=$(val POSTGRES_DB); [ -n "$D" ] || D=$U
P=$(val POSTGRES_PASSWORD)
if [ -n "$P" ]; then PGPASSWORD=$P; export PGPASSWORD; fi
case "$1" in
  dump-custom) exec pg_dump -U "$U" -d "$D" -Fc ;;
  dump-all) exec pg_dumpall -U "$U" ;;
  restore-custom) exec pg_restore -U "$U" -d "$D" --no-owner --no-acl --exit-on-error ;;
  restore-custom-clean)
    reset
    exec pg_restore -U "$U" -d "$D" --no-owner --no-acl --exit-on-error --clean --if-exists ;;
  restore-sql) exec psql -U "$U" -d "$D" -X -q -v ON_ERROR_STOP=1 -f - ;;
  restore-sql-clean)
    reset
    exec psql -U "$U" -d "$D" -X -q -v ON_ERROR_STOP=1 -f - ;;
  *) echo "unknown mode" >&2; exit 64 ;;
esac
`;

export const MYSQL_MODES = [
  'dump',
  'dump-all',
  'restore',
  'restore-clean',
  'restore-all',
] as const;
export type MysqlMode = (typeof MYSQL_MODES)[number];

/**
 * MySQL and MariaDB. The password goes in MYSQL_PWD (which both clients read), never in the arguments, where any process
 * of the container could read it. Root is used when its password is known or no other user is configured; otherwise the
 * app's own user. The database is the one the image was started with, or the only one that is not the server's own.
 */
export const MYSQL_SCRIPT = `set -e
${READ_SETTING}
RP=$(val MYSQL_ROOT_PASSWORD); [ -n "$RP" ] || RP=$(val MARIADB_ROOT_PASSWORD)
UU=$(val MYSQL_USER); [ -n "$UU" ] || UU=$(val MARIADB_USER)
UP=$(val MYSQL_PASSWORD); [ -n "$UP" ] || UP=$(val MARIADB_PASSWORD)
DB=$(val MYSQL_DATABASE); [ -n "$DB" ] || DB=$(val MARIADB_DATABASE)
if command -v mariadb-dump >/dev/null 2>&1 && ! command -v mysqldump >/dev/null 2>&1; then DUMP=mariadb-dump; CLI=mariadb; else DUMP=mysqldump; CLI=mysql; fi
if [ -n "$RP" ] || [ -z "$UU" ]; then U=root; MYSQL_PWD=$RP; else U=$UU; MYSQL_PWD=$UP; fi
export MYSQL_PWD
main_db() {
  if [ -n "$DB" ]; then printf %s "$DB"; return 0; fi
  all=$(echo 'SHOW DATABASES' | "$CLI" -u"$U" -N) || return 1
  mine=$(printf '%s\\n' "$all" | grep -v -x -e information_schema -e performance_schema -e mysql -e sys || true)
  n=$(printf '%s\\n' "$mine" | grep -c . || true)
  if [ "$n" = 1 ]; then printf %s "$mine"; return 0; fi
  echo "The server holds $n databases and the app does not name one: choose all databases." >&2
  return 1
}
case "$1" in
  dump) D=$(main_db) || exit 66; exec "$DUMP" -u"$U" --single-transaction --routines --triggers --events "$D" ;;
  dump-all) exec "$DUMP" -u"$U" --single-transaction --routines --triggers --events --all-databases ;;
  restore) D=$(main_db) || exit 66; exec "$CLI" -u"$U" "$D" ;;
  restore-clean)
    D=$(main_db) || exit 66
    case "$D" in *[!A-Za-z0-9_$-]*) echo "The database name has characters Provelox will not put in a statement." >&2; exit 65 ;; esac
    printf 'DROP DATABASE IF EXISTS \`%s\`; CREATE DATABASE \`%s\`;\\n' "$D" "$D" | "$CLI" -u"$U"
    exec "$CLI" -u"$U" "$D" ;;
  restore-all) exec "$CLI" -u"$U" ;;
  *) echo "unknown mode" >&2; exit 64 ;;
esac
`;

/** Which of the dump tools the container holds. Prints one name per line. Read-only. */
export const PROBE_SCRIPT = `for t in pg_dump pg_dumpall pg_restore psql mysqldump mysql mariadb-dump mariadb; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; true`;
