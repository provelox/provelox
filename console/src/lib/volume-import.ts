/**
 * The import folder on the server, as the console talks about it: where archives are put (rsync, scp) to be restored
 * from there, and where "Save a copy on the server" writes. Large data goes this way, because a browser upload has to
 * arrive within about a minute (the proxy's limit), and a copy between servers should not pass through a laptop.
 */

export interface ImportFile {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Whether it starts like a gzip file. A volume archive that does not cannot be restored. */
  gzip: boolean;
  /** What it is for: a volume archive or a database dump. Absent from instances that only hold volume archives. */
  kind?: ImportKind;
}

export interface ImportsListing {
  /** Where the folder is on the server */
  dir: string;
  files: ImportFile[];
  freeBytes: number | null;
}

/** What the API says about a copy it saved on the server */
export interface ExportedCopy {
  file: string;
  sizeBytes: number;
  dir: string;
  stopped: boolean;
  note: string;
}

/** The folder when the API does not say (older instances never get this far: they have no folder) */
export const IMPORTS_DEFAULT_DIR = '/var/lib/provelox/imports';

/** A browser upload above this is warned about: it has to arrive within about a minute, which a big file seldom does */
export const UPLOAD_WARN_BYTES = 200 * 1024 * 1024;
/** Above this a browser upload is not offered at all: use the server folder */
export const UPLOAD_REFUSE_BYTES = 2 * 1024 ** 3;

export type UploadAdvice = 'ok' | 'warn' | 'refuse';

/** Whether a file of this size should go through the browser: fine, risky, or not at all */
export function uploadAdvice(bytes: number): UploadAdvice {
  if (bytes > UPLOAD_REFUSE_BYTES) return 'refuse';
  if (bytes > UPLOAD_WARN_BYTES) return 'warn';
  return 'ok';
}

/** The address to put in a command: the host the console is opened at, if it looks like one, else something to replace */
export function hostForHints(hostname?: string | null): string {
  return hostname && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(hostname)
    ? hostname
    : '<server>';
}

/** A word for a shell: left as it is when it is plain, quoted when it is not */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9._/:@=+,~-]+$/.test(s)
    ? s
    : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command that puts a local file into the folder. rsync carries on where it stopped if the connection drops. */
export function rsyncUpCommand(
  host: string,
  dir: string,
  localFile = './your-file.tar.gz',
): string {
  return `rsync -avP ${shellWord(localFile)} root@${host}:${shellWord(`${dir.replace(/\/+$/, '')}/`)}`;
}

/** The command that fetches a saved copy from the folder to the machine it is run on */
export function rsyncDownCommand(
  host: string,
  dir: string,
  file: string,
  destination = './',
): string {
  return `rsync -avP root@${host}:${shellWord(`${dir.replace(/\/+$/, '')}/${file}`)} ${shellWord(destination)}`;
}

/** The command to run on a NEW server to pull a copy straight from the old one, without it passing through a laptop */
export function rsyncBetweenServersCommand(
  oldHost: string,
  dir: string,
  file: string,
): string {
  const d = dir.replace(/\/+$/, '');
  return `rsync -avP root@${oldHost}:${shellWord(`${d}/${file}`)} ${shellWord(`${d}/`)}`;
}

const seg = encodeURIComponent;

/** Where the browser asks for a copy of a volume to be saved on the server. The console's own route calls the API. */
export const volumeExportUrl = (app: string, volume: string, stop: boolean) =>
  `/api/volumes/${seg(app)}/${seg(volume)}/export${stop ? '?stop=1' : ''}`;

/** Where the browser asks for a restore from a file in the folder. No body: the file is already on the server. */
export function volumeRestoreFromUrl(
  app: string,
  volume: string,
  file: string,
  replace: { confirm: string } | null,
): string {
  const base = `/api/volumes/${seg(app)}/${seg(volume)}/restore?from=${seg(file)}`;
  return replace ? `${base}&replace=1&confirm=${seg(replace.confirm)}` : base;
}

/**
 * Whether Restore may be pressed for a file on the server: one is chosen and it is a gzip archive, and to replace what
 * is there the app's name has to be typed exactly.
 */
export function canRestoreFromServer(opts: {
  file: ImportFile | null;
  replace: boolean;
  typed: string;
  appName: string;
}): boolean {
  if (!opts.file || !opts.file.gzip) return false;
  return !opts.replace || opts.typed === opts.appName;
}

/** A reason this file cannot be restored right now, or null: not gzip, or less free room than the archive itself */
export function restoreProblem(
  file: ImportFile,
  freeBytes: number | null,
): string | null {
  if (!file.gzip) return 'This file is not a gzip archive (.tar.gz).';
  if (freeBytes !== null && freeBytes < file.sizeBytes)
    return 'The server has less free space than the archive itself, and it grows when unpacked.';
  return null;
}

/** The message in an answer from one of the routes, whatever shape it came in */
export function importError(
  body: unknown,
  status: number,
  what = 'The request',
): string {
  const e = (body as { error?: unknown } | null)?.error;
  if (typeof e === 'string' && e) return e;
  const m = (e as { message?: unknown } | undefined)?.message;
  if (typeof m === 'string' && m) return m;
  return status === 401
    ? 'Your session has ended. Sign in again, then try again.'
    : `${what} failed (${status}).`;
}

/**
 * What a file in the folder is for, from its name alone, by the same strict rules the API holds to. A volume archive is a
 * .tar.gz or .tgz; a database dump is a .dump (PostgreSQL's own format), a .sql or a .sql.gz. A volume is only restored
 * from the first kind and a database only from the second.
 */
export type ImportKind = 'volume' | 'database';

export function importKind(name: string): ImportKind | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes('..'))
    return null;
  if (/\.(tar\.gz|tgz)$/.test(name)) return 'volume';
  if (/\.(dump|sql\.gz|sql)$/.test(name)) return 'database';
  return null;
}

/** Whether a file name could be one in the folder at all (either kind), for deleting a file */
export const isImportFileName = (name: string) => importKind(name) !== null;

/** Whether a file name could be a volume archive: what a volume restore accepts */
export const isVolumeFileName = (name: string) => importKind(name) === 'volume';

/** The files of one kind. A listing from an instance that does not say (older ones) is taken to hold volume archives. */
export function filesOfKind(
  listing: ImportsListing | null,
  kind: ImportKind,
): ImportFile[] {
  return (listing?.files ?? []).filter(
    (f) => (f.kind ?? importKind(f.name) ?? 'volume') === kind,
  );
}
