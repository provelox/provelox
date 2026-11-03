import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { CONFIG, type Config } from '../config/config';
import {
  DOCKER,
  type DockerPort,
  type StreamHelperSpec,
} from '../docker/docker.port';
import type { Readable } from 'node:stream';
import {
  DELETE_SCRIPT,
  DISCARD_PART_SCRIPT,
  ENSURE_SCRIPT,
  EXPORT_SCRIPT,
  FINISH_PART_SCRIPT,
  KIND_EXTENSIONS,
  LIST_SCRIPT,
  READ_FILE_SCRIPT,
  WRITE_PART_SCRIPT,
  importKind,
  parseListing,
  type ImportFile,
  type ImportKind,
  type ImportsListing,
} from './imports';

/** What a helper that writes into the folder needs besides nothing: to read and write whatever the owner of a file */
const FILE_CAPS = ['DAC_READ_SEARCH', 'DAC_OVERRIDE'];

/**
 * The import folder on the server, reached only through short-lived helper containers (the API itself runs in a container
 * and never sees the folder). The folder is the one in IMPORTS_DIR; no other path is accepted, and a file is only ever
 * named, then looked up in what the folder really holds. Listing and restoring mount it read-only; only saving a copy
 * and deleting a file mount it read-write.
 */
@Injectable()
export class ImportsService {
  private ensured = false;

  constructor(
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** Where the folder is on the server */
  get dir(): string {
    return this.cfg.IMPORTS_DIR;
  }

  /** The folder as a mount for a helper (a host path: Docker treats a source starting with "/" as a bind mount) */
  mount(readOnly: boolean) {
    return { volume: this.dir, target: '/imports', readOnly };
  }

  /**
   * Throws 400 for a name that cannot name a file here. With `kind` it also has to be a file of that kind: a volume is
   * restored only from .tar.gz or .tgz and a database only from .dump, .sql or .sql.gz, so neither can be given the
   * other's file. Without `kind` either kind will do (deleting a file, say).
   */
  assertName(name: unknown, kind?: ImportKind): asserts name is string {
    const k = importKind(name);
    if (k === null || (kind !== undefined && k !== kind))
      throw new ValidationError(
        `That is not a file name this ${kind === 'database' ? 'database restore' : kind === 'volume' ? 'volume restore' : 'folder'} can use: use letters, digits and . _ - only, ending in ${kind ? KIND_EXTENSIONS[kind] : `${KIND_EXTENSIONS.volume} (a volume archive) or ${KIND_EXTENSIONS.database} (a database dump)`}.`,
      );
  }

  /** Runs a helper to the end and returns what it printed (a little of it) and how it ended */
  async run(
    spec: Omit<StreamHelperSpec, 'image' | 'kind'>,
    what: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let h;
    try {
      h = await this.docker.streamHelper({
        image: this.cfg.HELPER_IMAGE,
        kind: 'import',
        ...spec,
      });
    } catch (e) {
      throw new ServiceUnavailableException(
        `Could not ${what}: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of h.stdout) {
      // a listing is a few kilobytes: whatever is beyond that is not something to hold
      if (size < 256_000) {
        parts.push(c as Buffer);
        size += (c as Buffer).length;
      }
    }
    const r = await h.done;
    return {
      exitCode: r.exitCode,
      stdout: Buffer.concat(parts).toString('utf8'),
      stderr: r.stderr,
    };
  }

  /** Makes sure the folder is there and private. Docker creates a missing folder when a helper mounts it; this sets its mode. */
  async ensure(): Promise<void> {
    if (this.ensured) return;
    const r = await this.run(
      {
        entrypoint: ['sh'],
        command: ['-c', ENSURE_SCRIPT],
        mounts: [this.mount(false)],
        capabilities: ['DAC_READ_SEARCH'],
      },
      'prepare the import folder',
    );
    if (r.exitCode !== 0)
      throw new ServiceUnavailableException(
        `Could not prepare the import folder ${this.dir}. ${r.stderr}`.trim(),
      );
    this.ensured = true;
  }

  /** What is in the folder now (read-only), newest first, and how much room the disk has */
  async list(): Promise<ImportsListing> {
    await this.ensure();
    const r = await this.run(
      {
        entrypoint: ['sh'],
        command: ['-c', LIST_SCRIPT],
        mounts: [this.mount(true)],
        capabilities: ['DAC_READ_SEARCH'],
      },
      'read the import folder',
    );
    if (r.exitCode !== 0)
      throw new ServiceUnavailableException(
        `Could not read the import folder ${this.dir}. ${r.stderr}`.trim(),
      );
    return parseListing(r.stdout, this.dir);
  }

  /**
   * One file of the folder, by name, as the folder holds it now. 400 for a bad name (or one of the wrong kind, when
   * `kind` is given), 404 for one that is not there.
   */
  async find(
    name: unknown,
    kind?: ImportKind,
  ): Promise<{ file: ImportFile; listing: ImportsListing }> {
    this.assertName(name, kind);
    const listing = await this.list();
    const file = listing.files.find((f) => f.name === name);
    if (!file)
      throw new NotFoundError(
        `There is no file "${name}" in the import folder ${listing.dir}. Put it there with rsync or scp, then try again.`,
      );
    return { file, listing };
  }

  /** Removes one file from the folder. The name has to be sent again as `confirm`. */
  async remove(name: unknown, confirm: unknown): Promise<void> {
    this.assertName(name);
    if (confirm !== name)
      throw new ValidationError(
        `Deleting a file cannot be undone. Confirm by sending the file name, "${name}", as confirm.`,
      );
    await this.find(name);
    const r = await this.run(
      {
        entrypoint: ['sh'],
        command: ['-c', DELETE_SCRIPT, 'sh', name],
        mounts: [this.mount(false)],
        capabilities: FILE_CAPS,
      },
      'delete the file',
    );
    if (r.exitCode === 3)
      throw new ConflictError(`"${name}" is no longer a plain file there.`);
    if (r.exitCode !== 0)
      throw new ServiceUnavailableException(
        `Could not delete "${name}". ${r.stderr}`.trim(),
      );
  }

  /**
   * Starts copying `input` into a hidden part file for `file` (read-write on the folder, nothing else mounted, no
   * network). Resolves when the copy has ended. The file does not exist for anyone until `finishPart`; `discardPart`
   * removes what was written. Used for a database dump, whose tool reports whether it was whole only when it has ended.
   */
  async writePart(
    file: string,
    input: Readable,
  ): Promise<{ sizeBytes: number }> {
    this.assertName(file, 'database');
    await this.ensure();
    const r = await this.run(
      {
        entrypoint: ['sh'],
        command: ['-c', WRITE_PART_SCRIPT, 'sh', file],
        mounts: [this.mount(false)],
        capabilities: FILE_CAPS,
        input,
      },
      'save the dump',
    );
    if (r.exitCode === 5)
      throw new ConflictError(
        `A file named "${file}" is already in the import folder. Try again in a moment.`,
      );
    if (r.exitCode === 8)
      throw new ServiceUnavailableException(
        `The dump could not be written to the end (the disk is probably full), so it was not kept. ${r.stderr}`.trim(),
      );
    const size = /^size=(\d+)$/m.exec(r.stdout);
    if (r.exitCode !== 0 || !size)
      throw new ServiceUnavailableException(
        `The dump could not be saved (exit code ${r.exitCode}). ${r.stderr}`.trim(),
      );
    return { sizeBytes: Number(size[1]) };
  }

  /** Moves a finished part file into place, so the file appears in the folder. */
  async finishPart(file: string): Promise<void> {
    this.assertName(file, 'database');
    const r = await this.run(
      {
        entrypoint: ['sh'],
        command: ['-c', FINISH_PART_SCRIPT, 'sh', file],
        mounts: [this.mount(false)],
        capabilities: FILE_CAPS,
      },
      'finish the dump',
    );
    if (r.exitCode === 5)
      throw new ConflictError(
        `A file named "${file}" is already in the import folder. Try again in a moment.`,
      );
    if (r.exitCode !== 0)
      throw new ServiceUnavailableException(
        `The dump was written but could not be put in place (exit code ${r.exitCode}). ${r.stderr}`.trim(),
      );
  }

  /** Removes a part file that was not finished. Never throws: it runs on the way out of a failure. */
  async discardPart(file: string): Promise<void> {
    if (importKind(file) !== 'database') return;
    try {
      await this.run(
        {
          entrypoint: ['sh'],
          command: ['-c', DISCARD_PART_SCRIPT, 'sh', file],
          mounts: [this.mount(false)],
          capabilities: FILE_CAPS,
        },
        'remove the unfinished dump',
      );
    } catch {
      // nothing more can be done, and the original failure is what matters
    }
  }

  /**
   * A helper that writes one file of the folder to its standard output (folder mounted read-only, no network), for a
   * database restore to read. The caller reads `stdout`, and calls `abort` when it is done or gives up; `done` says
   * whether the file was read to its end.
   */
  async readFile(file: string) {
    this.assertName(file, 'database');
    try {
      return await this.docker.streamHelper({
        image: this.cfg.HELPER_IMAGE,
        kind: 'import',
        entrypoint: ['sh'],
        command: ['-c', READ_FILE_SCRIPT, 'sh', file],
        mounts: [this.mount(true)],
        capabilities: ['DAC_READ_SEARCH'],
      });
    } catch (e) {
      throw new ServiceUnavailableException(
        `Could not read the file: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Saves the contents of a Docker volume into the folder as `file` (read-only on the volume, read-write on the folder).
   * Written under a hidden name and moved into place when complete, so a copy that fails leaves nothing behind.
   */
  async exportVolume(
    dockerVolume: string,
    file: string,
  ): Promise<{ sizeBytes: number; note: string }> {
    this.assertName(file, 'volume');
    await this.ensure();
    const r = await this.run(
      {
        entrypoint: ['sh'],
        command: ['-c', EXPORT_SCRIPT, 'sh', file],
        mounts: [
          { volume: dockerVolume, target: '/data', readOnly: true },
          this.mount(false),
        ],
        capabilities: FILE_CAPS,
      },
      'save the copy',
    );
    if (r.exitCode === 5)
      throw new ConflictError(
        `A file named "${file}" is already in the import folder. Try again in a moment.`,
      );
    if (r.exitCode === 8)
      throw new ServiceUnavailableException(
        `The copy was cut short (the disk is probably full), so it was not kept. ${r.stderr}`.trim(),
      );
    if (r.exitCode !== 0 && r.exitCode !== 1)
      throw new ServiceUnavailableException(
        `The copy could not be saved (exit code ${r.exitCode}). ${r.stderr}`.trim(),
      );
    const size = /^size=(\d+)$/m.exec(r.stdout);
    if (!size)
      throw new ServiceUnavailableException(
        `The copy was made but its size could not be read. ${r.stderr}`.trim(),
      );
    return {
      sizeBytes: Number(size[1]),
      note:
        r.exitCode === 1
          ? 'Some files changed or vanished while they were read and were left out.'
          : '',
    };
  }
}
