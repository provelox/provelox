/**
 * The import folder: one fixed folder on the SERVER where archives of volumes and dumps of databases are saved, and where
 * a large file is put (with rsync or scp) to be restored, so big data never goes through a browser. Everything here is plain text and pure,
 * so it can be tested without Docker. The folder is only ever touched by short-lived helper containers (see
 * ImportsService), and a file is only ever named, never given as a path: that is what keeps "restore from the server"
 * from becoming "read any file of the machine".
 */

/** A file in the folder is known by its name alone: no slash, no leading dot, nothing a shell or a path could take apart */
export const IMPORT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * What a file in the folder is for, told by its name alone. A volume archive is a .tar.gz or .tgz; a database dump is a
 * .dump (PostgreSQL's own format), a .sql or a .sql.gz. This is the ONE place that says so: a volume is only ever
 * restored from the first kind and a database only from the second, so a dump cannot be unpacked into a volume, nor an
 * archive fed to a database tool.
 */
export type ImportKind = 'volume' | 'database';

const VOLUME_EXT = /\.(tar\.gz|tgz)$/;
const DATABASE_EXT = /\.(dump|sql\.gz|sql)$/;

/** The endings of each kind, in words, so a refusal says which files a place takes */
export const KIND_EXTENSIONS: Record<ImportKind, string> = {
  volume: '.tar.gz or .tgz',
  database: '.dump, .sql or .sql.gz',
};

/** The kind a name is for, or null when this folder cannot hold it: the strict pattern, no ".." anywhere, and a known ending */
export function importKind(name: unknown): ImportKind | null {
  if (
    typeof name !== 'string' ||
    !IMPORT_NAME_RE.test(name) ||
    name.includes('..')
  )
    return null;
  if (VOLUME_EXT.test(name)) return 'volume';
  if (DATABASE_EXT.test(name)) return 'database';
  return null;
}

/** Whether `name` may name a file in the folder at all (either kind) */
export const isImportName = (name: unknown): name is string =>
  importKind(name) !== null;

/** The most files listed (the newest) */
export const IMPORTS_LISTED = 200;

export interface ImportFile {
  name: string;
  sizeBytes: number;
  /** ISO time of the last change */
  modifiedAt: string;
  /** Whether it starts like a gzip file. For a volume archive, anything else cannot be restored. */
  gzip: boolean;
  /** What it is for, from its name: a volume archive or a database dump */
  kind: ImportKind;
}

export interface ImportsListing {
  /** Where the folder is on the server, to tell people where to put files */
  dir: string;
  files: ImportFile[];
  /** Free space on the disk the folder is on, in bytes. Null when it could not be read. */
  freeBytes: number | null;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 50);

/** 20260102-030405, in UTC */
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d+Z$/, '');

/** The name a saved copy gets: the app, the volume and the time, like a download's file name. Always a valid import name. */
export function exportFileName(app: string, volume: string, now: Date): string {
  const name = `${slug(app)}-${slug(volume)}-${stamp(now)}.tar.gz`.replace(
    /\.{2,}/g,
    '.',
  );
  // a slug that starts with a dot or a dash cannot start the name
  return /^[A-Za-z0-9]/.test(name) ? name : `v${name}`;
}

/*
 * The programs the helpers run. Each is fixed text for `sh -c`; what varies (a file name) is passed as an argument and
 * read as "$1", never put into the text, so no name can become part of a command. The folder is /imports and the
 * volume /data inside the helper. `head -c 2 | od` reads the first two bytes: 1f8b is gzip.
 */

/** The name in $1 must be a bare file name: not empty, no slash, no leading dot. (The API checks too; this is the second lock.) */
const BARE_NAME =
  'case "$1" in ""|*/*|.*) echo "that is not a bare file name" >&2; exit 3;; esac';

const IS_FILE = '[ -f "$f" ] && [ ! -L "$f" ]';
const IS_GZIP =
  '[ "$(head -c 2 "$f" | od -An -tx1 | tr -d \' \\n\')" = "1f8b" ]';

/** Makes the folder private to root. A folder someone else made is left as it is (and still works). */
export const ENSURE_SCRIPT =
  'chmod 700 /imports 2>/dev/null || echo "left the folder mode as it is" >&2; exit 0';

/**
 * One line per regular file ending in .tar.gz, .tgz, .dump, .sql.gz or .sql: F, name, size, modified (seconds), 1 if it
 * starts like gzip. (No name matches two of these patterns, so none is listed twice, and the hidden ".part" files of a
 * copy in progress start with a dot, so the patterns never match them.) Links and folders are not regular files, so they
 * are never listed. Then D and the free kilobytes of the disk.
 */
export const LIST_SCRIPT = [
  'cd /imports 2>/dev/null || { echo "the folder is not there" >&2; exit 2; }',
  'for f in *.tar.gz *.tgz *.dump *.sql.gz *.sql; do',
  `  ${IS_FILE} || continue`,
  `  g=0; ${IS_GZIP} && g=1`,
  '  printf "F\\t%s\\t%s\\t%s\\t%s\\n" "$f" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$g"',
  'done',
  'printf "D\\t%s\\n" "$(df -Pk /imports | tail -n 1 | tr -s " " | cut -d" " -f4)"',
].join('\n');

/**
 * Archives the volume into the folder under the name in $1. It is written as a hidden ".part" file and moved into place
 * only when it is whole, so a half-written file is never listed or restored; a failed copy removes it. tar exits 1 when
 * files changed while they were read (the archive is complete then), but busybox's tar also exits 1 when the disk is
 * full, so the exit code alone cannot say: the file is only kept if `gzip -t` reads it to the end without a fault.
 * Exit 8 means tar said "fine" or "files changed" but the archive is cut short. An existing file of that name is
 * never overwritten.
 */
export const EXPORT_SCRIPT = [
  BARE_NAME,
  'tmp="/imports/.$1.part"',
  '[ -e "/imports/$1" ] && { echo "a file with that name is already there" >&2; exit 5; }',
  'tar -c -z -f "$tmp" -C /data .',
  'rc=$?',
  'if [ "$rc" -le 1 ] && gzip -t "$tmp" 2>/dev/null; then',
  '  mv "$tmp" "/imports/$1" || { rm -f "$tmp"; exit 4; }',
  '  printf "size=%s\\n" "$(stat -c %s "/imports/$1")"',
  '  exit "$rc"',
  'fi',
  'rm -f "$tmp"',
  '[ "$rc" -le 1 ] && rc=8',
  'exit "$rc"',
].join('\n');

/**
 * Before anything is changed, checks that the file in $1 is a regular file that starts like gzip (a file that was
 * swapped since it was listed is refused, exit 3, with nothing touched), then extracts it into /data keeping owners and
 * modes. When replacing, the volume is emptied first, and only after those checks.
 */
const restoreFrom = (replace: boolean) =>
  [
    BARE_NAME,
    'f="/imports/$1"',
    `${IS_FILE} || { echo "that is not a file in the folder" >&2; exit 3; }`,
    `${IS_GZIP} || { echo "that file is not a gzip archive" >&2; exit 3; }`,
    ...(replace ? ['find /data -mindepth 1 -delete || exit 6'] : []),
    'exec tar -x -z -p -f "$f" -C /data',
  ].join('\n');
export const RESTORE_FROM_SCRIPT = restoreFrom(false);
export const REPLACE_FROM_SCRIPT = restoreFrom(true);

/** Removes the regular file named in $1, and nothing else (not a link, not a folder). */
export const DELETE_SCRIPT = [
  BARE_NAME,
  'f="/imports/$1"',
  `${IS_FILE} || { echo "that is not a file in the folder" >&2; exit 3; }`,
  'rm -f -- "$f"',
].join('\n');

/**
 * Saving a dump into the folder takes three small helpers, because only after the dump tool has ended is it known
 * whether the file is whole. WRITE_PART copies its standard input into a hidden ".part" file named for $1 and prints the
 * size (exit 5: the name is taken; exit 8: it could not be written to the end, the disk is probably full; either way the
 * part file is gone). FINISH_PART moves it into place, which is what makes it appear in the listing. DISCARD_PART removes
 * it. A half-written dump is never listed, and an existing file is never overwritten.
 */
export const WRITE_PART_SCRIPT = [
  BARE_NAME,
  'tmp="/imports/.$1.part"',
  '[ -e "/imports/$1" ] && { echo "a file with that name is already there" >&2; exit 5; }',
  'cat > "$tmp" || { rm -f "$tmp"; exit 8; }',
  'printf "size=%s\\n" "$(stat -c %s "$tmp")"',
].join('\n');

export const FINISH_PART_SCRIPT = [
  BARE_NAME,
  'tmp="/imports/.$1.part"',
  '[ -f "$tmp" ] && [ ! -L "$tmp" ] || { echo "there is no part file to finish" >&2; exit 3; }',
  '[ -e "/imports/$1" ] && { rm -f "$tmp"; echo "a file with that name is already there" >&2; exit 5; }',
  'mv "$tmp" "/imports/$1" || { rm -f "$tmp"; exit 4; }',
].join('\n');

export const DISCARD_PART_SCRIPT = [
  BARE_NAME,
  'rm -f -- "/imports/.$1.part"',
].join('\n');

/**
 * Writes the regular file named in $1 to standard output, and nothing else (not a link, not a folder). A dump is read
 * this way and handed to the database's restore tool: the folder is mounted read-only, and the only path ever used is
 * this one validated name.
 */
export const READ_FILE_SCRIPT = [
  BARE_NAME,
  'f="/imports/$1"',
  `${IS_FILE} || { echo "that is not a file in the folder" >&2; exit 3; }`,
  'exec cat -- "$f"',
].join('\n');

/** What a listing helper printed, as the listing: invalid names and unreadable lines are dropped. Newest first. */
export function parseListing(output: string, dir: string): ImportsListing {
  const files: ImportFile[] = [];
  let freeBytes: number | null = null;
  for (const line of output.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'F' && f.length === 5) {
      const sizeBytes = Number(f[2]);
      const mtime = Number(f[3]);
      const kind = importKind(f[1]);
      if (
        !kind ||
        f[2] === '' ||
        f[3] === '' ||
        !Number.isFinite(sizeBytes) ||
        !Number.isFinite(mtime)
      )
        continue;
      files.push({
        name: f[1],
        sizeBytes,
        modifiedAt: new Date(mtime * 1000).toISOString(),
        gzip: f[4] === '1',
        kind,
      });
    } else if (f[0] === 'D' && f.length === 2) {
      const kb = Number(f[1]);
      if (f[1] !== '' && Number.isFinite(kb)) freeBytes = kb * 1024;
    }
  }
  files.sort(
    (a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name),
  );
  return { dir, files: files.slice(0, IMPORTS_LISTED), freeBytes };
}
