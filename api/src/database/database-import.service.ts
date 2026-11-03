import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DomainError, ValidationError } from '../common/errors';
import { ImportsService } from '../imports/imports.service';
import { DatabaseBackupService } from './database-backup.service';
import { tail } from './stream-util';

export interface DatabaseExportResult {
  /** The file now in the import folder, and its size */
  file: string;
  sizeBytes: number;
  /** Where the folder is on the server */
  dir: string;
}

export interface DatabaseFromFileResult {
  restored: true;
  /** The file that was restored, and its size */
  file: string;
  bytes: number;
}

/**
 * Moves a database's dump through the import folder on the server: save a dump into it, and restore from a file that was
 * put there (rsync, scp). The same dump and restore as the browser's (the database's own tools, run inside the app's
 * container, the app keeps running), without a browser in between, so there is no limit on how big a dump may be. A file
 * is only ever named and then found in the folder, and a database only takes .dump, .sql and .sql.gz files, never a
 * volume archive.
 */
@Injectable()
export class DatabaseImportService {
  private readonly log = new Logger('DatabaseImport');

  constructor(
    private readonly backups: DatabaseBackupService,
    private readonly imports: ImportsService,
  ) {}

  /**
   * Saves a dump of the app's database into the import folder. `all` dumps every database of the server. The dump
   * streams into a hidden part file; only when the dump tool has ended successfully is the file moved into place, so a
   * dump that died half way is never listed, and what was written is removed.
   */
  async exportDump(
    appName: string,
    opts: { all?: boolean } = {},
    now = new Date(),
  ): Promise<DatabaseExportResult> {
    // The dump starts first, so an app that is not a database, not running or elsewhere is refused before a file is made
    const dump = await this.backups.dump(appName, { all: opts.all }, now);
    const file = dump.filename;
    let written: { sizeBytes: number };
    try {
      this.imports.assertName(file, 'database');
      written = await this.imports.writePart(file, dump.stream);
    } catch (e) {
      // Stop the tool inside the container, which may still be waiting for something to read what it writes
      await dump.abort();
      await this.imports.discardPart(file);
      throw e;
    }
    const end = await dump.finished;
    if (!end.ok) {
      await this.imports.discardPart(file);
      throw new ServiceUnavailableException(
        `The dump did not finish, so no file was saved. ${end.detail}`.trim(),
      );
    }
    try {
      await this.imports.finishPart(file);
    } catch (e) {
      await this.imports.discardPart(file);
      throw e;
    }
    return { file, sizeBytes: written.sizeBytes, dir: this.imports.dir };
  }

  /**
   * Restores a dump that is in the import folder into the app's database, while the app runs. Without `clean` it is
   * added to what is there; with it the database's contents are dropped first, which needs `confirm` to be the app's
   * name. The file is read by a helper with the folder mounted read-only and streamed into the tool: the format is read
   * from its first bytes before anything is changed, so a dump of the wrong engine is refused with the database untouched.
   */
  async restoreFrom(
    appName: string,
    fileName: unknown,
    opts: { clean?: boolean; confirm?: string } = {},
  ): Promise<DatabaseFromFileResult> {
    // Only a dump: a volume archive is never fed to a database tool
    this.imports.assertName(fileName, 'database');
    if (opts.clean && opts.confirm !== appName)
      throw new ValidationError(
        `Replacing what is in the database needs the app's name to confirm: "${appName}".`,
      );
    // Known to be in the folder (404 otherwise) before anything starts
    const { file } = await this.imports.find(fileName, 'database');
    const helper = await this.imports.readFile(file.name);
    try {
      const r = await this.backups.restore(appName, helper.stdout, {
        clean: opts.clean,
        confirm: opts.confirm,
      });
      // The tool is told the file is over when the helper's output ends, so a file that stopped being readable half way
      // would look like a short dump. The helper's own exit code says whether it was read to the end.
      const read = await helper.done;
      if (read.exitCode !== 0) {
        this.log.warn(`reading ${file.name} ended with ${read.exitCode}`);
        throw new DomainError(
          `The file could not be read to the end (exit code ${read.exitCode}${tail(read.stderr) ? `: ${tail(read.stderr)}` : ''}), so the database may be only partly restored.`,
          422,
          'restore_failed',
        );
      }
      return { restored: true, file: file.name, bytes: r.bytes };
    } finally {
      // A refusal before the tool starts leaves the helper waiting for someone to read it
      await helper.abort();
    }
  }
}
