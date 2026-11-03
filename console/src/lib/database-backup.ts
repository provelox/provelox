import { importKind } from './volume-import';

/** What the API says about the database an app runs (GET /v1/apps/:name/database) */
export interface DatabaseInfo {
  engine: 'postgres' | 'mysql' | 'mariadb' | null;
  canBackup: boolean;
  reason?: string;
}

export const ENGINE_LABEL: Record<
  NonNullable<DatabaseInfo['engine']>,
  string
> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
};

/** Where the browser is sent to take a dump. The console's own route streams it from the API. */
export function databaseDumpUrl(app: string, all: boolean): string {
  const base = `/api/databases/${encodeURIComponent(app)}/dump`;
  return all ? `${base}?all=1` : base;
}

/** Where a dump is sent to be restored. `replace` drops what is in the database first and names the app to confirm. */
export function databaseRestoreUrl(app: string, replace: boolean): string {
  const base = `/api/databases/${encodeURIComponent(app)}/restore`;
  return replace ? `${base}?clean=1&confirm=${encodeURIComponent(app)}` : base;
}

/** Whether a file name could be a dump in the import folder: .dump, .sql or .sql.gz, by the same strict rules as the API */
export const isDumpFileName = (name: string) => importKind(name) === 'database';

/** Where the browser asks for a dump to be saved in the import folder on the server (a POST, never a plain link) */
export function databaseExportUrl(app: string, all: boolean): string {
  const base = `/api/databases/${encodeURIComponent(app)}/export`;
  return all ? `${base}?all=1` : base;
}

/** Where the browser asks for a restore from a dump already in the folder. No body: the file is on the server. */
export function databaseRestoreFromUrl(
  app: string,
  file: string,
  replace: boolean,
): string {
  const base = `/api/databases/${encodeURIComponent(app)}/restore?from=${encodeURIComponent(file)}`;
  return replace ? `${base}&clean=1&confirm=${encodeURIComponent(app)}` : base;
}

/** What the API says about a dump it saved on the server */
export interface SavedDump {
  file: string;
  sizeBytes: number;
  dir: string;
}

/**
 * Whether Restore may be pressed for a dump on the server: one is chosen and it is not empty, and to replace what is
 * there the app's name has to be typed exactly.
 */
export function canRestoreFromServer(opts: {
  file: { name: string; sizeBytes: number } | null;
  replace: boolean;
  typed: string;
  appName: string;
}): boolean {
  if (
    !opts.file ||
    opts.file.sizeBytes === 0 ||
    !isDumpFileName(opts.file.name)
  )
    return false;
  return !opts.replace || opts.typed === opts.appName;
}

/** A reason this dump cannot be restored right now, or null: an empty file */
export function dumpProblem(file: { sizeBytes: number }): string | null {
  return file.sizeBytes === 0 ? 'This file is empty.' : null;
}

/** Whether the restore button may be pressed: a file chosen, and for "replace" the app's name typed exactly */
export function canRestore(opts: {
  file: { size: number } | null;
  replace: boolean;
  typed: string;
  appName: string;
  busy: boolean;
}): boolean {
  if (!opts.file || opts.file.size === 0 || opts.busy) return false;
  return !opts.replace || opts.typed.trim() === opts.appName;
}

/** The kinds of file a dump can be: what the dump button makes, and plain or gzipped SQL */
export const DUMP_ACCEPT = '.dump,.sql,.gz,.sql.gz,.backup';

/** What the API answered to a restore, in words for the person */
export function restoreErrorMessage(status: number, body: unknown): string {
  const text =
    body && typeof body === 'object'
      ? ((body as { error?: { message?: string } | string }).error ?? null)
      : null;
  const message =
    typeof text === 'string'
      ? text
      : text && typeof text === 'object'
        ? text.message
        : undefined;
  if (message) return message;
  if (status === 401) return 'Your sign-in has expired. Sign in again.';
  if (status === 403)
    return 'Restoring a database needs the administrator sign-in, not an access token.';
  if (status === 413) return 'The file is too large for the server to accept.';
  if (status === 0) return 'The upload was interrupted. Check the connection.';
  return `The restore did not finish (status ${status}).`;
}

/**
 * Sends a file to the restore route and reports how much has gone. Uses XMLHttpRequest because `fetch` cannot say how far
 * an upload has got. Aborting the signal cancels the upload, which stops the restore on the server.
 */
export function uploadDump(
  url: string,
  file: File,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<{ restored: true; bytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // an error page: the status says enough
      }
      if (xhr.status >= 200 && xhr.status < 300)
        resolve(body as { restored: true; bytes: number });
      else reject(new Error(restoreErrorMessage(xhr.status, body)));
    };
    xhr.onerror = () => reject(new Error(restoreErrorMessage(0, null)));
    xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
    const stop = () => xhr.abort();
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', stop);
    xhr.send(file);
  });
}
