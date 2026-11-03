/** The names a volume can have in an app's own list: what the download address accepts, nothing else */
export const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Whether an image is (by its name) a database. A copy of the files of a running database can be inconsistent and may
 * not restore, so the download says so for these. Judged by the repository name only, never the tag.
 */
export function looksLikeDatabase(image: string | undefined): boolean {
  if (!image) return false;
  const repo = image.split('@')[0].replace(/:[^/:]*$/, '');
  const name = repo.split('/').slice(-2).join('/').toLowerCase();
  return (
    /(postgres|postgis|pgvector|mysql|maria|mongo|redis|valkey|keydb|dragonfly|couch|cassandra|scylla|influx|timescale|clickhouse|elasticsearch|opensearch|neo4j|cockroach|percona|mssql|rethink|surreal|etcd|sqlite)/.test(
      name,
    ) || /(^|[/_.-])(db|database)([/_.-]|$)/.test(name)
  );
}

/** Where the browser is sent to download a volume. The console's own route streams it from the API. */
export function volumeDownloadUrl(
  app: string,
  volume: string,
  stopApp: boolean,
): string {
  const base = `/api/volumes/${encodeURIComponent(app)}/${encodeURIComponent(volume)}/download`;
  return stopApp ? `${base}?stop=1` : base;
}

/** Where the browser sends an archive to be put into a volume. The console's own route streams it on to the API. */
export function volumeRestoreUrl(
  app: string,
  volume: string,
  replace: { confirm: string } | null,
): string {
  const base = `/api/volumes/${encodeURIComponent(app)}/${encodeURIComponent(volume)}/restore`;
  return replace
    ? `${base}?replace=1&confirm=${encodeURIComponent(replace.confirm)}`
    : base;
}

/** A file that can be a download made here, or any tar archive compressed with gzip */
export const looksLikeArchiveName = (name: string) =>
  /\.(tar\.gz|tgz)$/i.test(name);

/**
 * Whether the restore button may be pressed: a file is chosen, and to replace what is there the app's name has to be
 * typed exactly, as it is for deleting an app.
 */
export function canRestore(opts: {
  file: boolean;
  replace: boolean;
  typed: string;
  appName: string;
}): boolean {
  if (!opts.file) return false;
  return !opts.replace || opts.typed === opts.appName;
}

/** The message in an answer from the restore route, whatever shape it came in */
export function restoreError(body: unknown, status: number): string {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === 'string' && e) return e;
  const m = (e as { message?: unknown } | undefined)?.message;
  if (typeof m === 'string' && m) return m;
  return status === 401
    ? 'Your session has ended. Sign in again, then restore.'
    : `The restore failed (${status}).`;
}
