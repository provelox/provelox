import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createGunzip, createGzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { AppsService } from '../apps/apps.service';
import type { AppDefinition } from '../apps/app.model';
import { ConflictError, DomainError, ValidationError } from '../common/errors';
import { serviceName } from '../common/naming';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import {
  chooseEngine,
  compatible,
  detectFormat,
  dumpFilename,
  nameHint,
  type DumpFormat,
  type Engine,
} from './engine';
import {
  MYSQL_SCRIPT,
  POSTGRES_SCRIPT,
  PROBE_SCRIPT,
  type MysqlMode,
  type PostgresMode,
} from './scripts';
import { ByteCounter, startedWithBytes, tail, takeHead } from './stream-util';

export interface DatabaseInfo {
  engine: Engine | null;
  canBackup: boolean;
  reason?: string;
}

/** A dump on its way to the browser */
export interface DatabaseDump {
  filename: string;
  contentType: string;
  stream: Readable;
  /** Resolves when the tool has exited and everything it wrote has been handed on. `ok` false: the dump is not complete. Never rejects. */
  finished: Promise<{ ok: boolean; detail: string }>;
  /** The reader went away: stop the tool inside the container */
  abort(): Promise<void>;
}

/** What is read of an upload before the tool is started: enough to see what kind of file it is, and where it came from */
const HEAD_BYTES = 8192;
/** How long what was found inside a container is kept */
const TOOLS_KEPT_MS = 60_000;
/** How long the look inside the container for the tools may take */
const PROBE_MS = 15_000;

/** The fixed command for an engine: `sh -c <script> sh <mode>`. The mode is one word from a list, nothing else varies. */
function command(engine: Engine, mode: PostgresMode | MysqlMode): string[] {
  return [
    'sh',
    '-c',
    engine === 'postgres' ? POSTGRES_SCRIPT : MYSQL_SCRIPT,
    'sh',
    mode,
  ];
}

/**
 * Backs up and restores the database an app runs, with the database's own tools, run inside the app's own container.
 * That is where the tools of the right version are, and where the credentials already are: they are read there from the
 * container's environment and never reach Provelox, the browser, a command line or a log. Only the dump or the file to
 * restore passes through, as a stream. The app keeps running.
 */
@Injectable()
export class DatabaseBackupService {
  constructor(
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
  ) {}

  /** The app, and the id of its running container on this machine. Says why when there is none. */
  private async running(
    appName: string,
  ): Promise<{ app: AppDefinition; container: string }> {
    const app = this.apps.getDefinition(appName);
    const local = await this.docker.localNodeId();
    if (local) {
      const held = this.apps.heldTo(app.name);
      const nodeId =
        held?.id ?? (await this.docker.lastTaskNode(serviceName(app.name)));
      if (nodeId && nodeId !== local) {
        const host =
          held?.host ??
          (await this.docker.listNodes().catch(() => [])).find(
            (n) => n.id === nodeId,
          )?.hostname ??
          'another machine';
        throw new ConflictError(
          `"${appName}" runs on ${host}. This API can only reach containers on the machine it runs on for now.`,
        );
      }
    }
    const container =
      app.instanceCount > 0
        ? await this.docker.serviceContainer(serviceName(app.name))
        : null;
    if (!container)
      throw new ConflictError(
        `"${appName}" is not running on this machine. Start the app first: the dump and restore tools run inside its container.`,
      );
    return { app, container };
  }

  /** Which of the dump tools the container holds, from a fixed read-only probe */
  private async probe(container: string): Promise<string[]> {
    const run = await this.docker.execStream({
      container,
      cmd: ['sh', '-c', PROBE_SCRIPT],
    });
    let out = '';
    run.stdout.setEncoding('utf8');
    run.stdout.on('data', (c: string) => (out += c));
    const timer = setTimeout(() => void run.abort(), PROBE_MS);
    try {
      const r = await run.done;
      if (r.exitCode !== 0)
        throw new ServiceUnavailableException(
          `Could not look inside the container for the database tools. ${tail(r.stderr)}`.trim(),
        );
    } finally {
      clearTimeout(timer);
    }
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** What a container's tools were found to be, kept for a minute so opening a page does not start a process every time */
  private readonly seen = new Map<string, { at: number; found: string[] }>();

  private async detect(
    app: AppDefinition,
    container: string,
  ): Promise<DatabaseInfo> {
    const hint = nameHint(app.image);
    if (hint === null) return { engine: null, canBackup: false };
    // A container id never changes its contents, so the answer is good for as long as the container lives
    const key = `${container}`;
    const cached = this.seen.get(key);
    let found: string[];
    if (cached && Date.now() - cached.at < TOOLS_KEPT_MS) found = cached.found;
    else {
      found = await this.probe(container);
      if (this.seen.size > 50) this.seen.clear();
      this.seen.set(key, { at: Date.now(), found });
    }
    const c = chooseEngine(hint, found);
    return c.canBackup
      ? { engine: c.engine, canBackup: true }
      : { engine: c.engine, canBackup: false, reason: c.reason };
  }

  /** What database the app runs and whether Provelox can back it up. */
  async info(appName: string): Promise<DatabaseInfo> {
    const { app, container } = await this.running(appName);
    return this.detect(app, container);
  }

  private async need(appName: string) {
    const { app, container } = await this.running(appName);
    const info = await this.detect(app, container);
    if (!info.canBackup || !info.engine)
      throw new ConflictError(
        info.reason ||
          `"${appName}" does not look like a database Provelox can back up (PostgreSQL, MySQL or MariaDB).`,
      );
    return { engine: info.engine, container };
  }

  /**
   * A dump of the app's database, streamed. PostgreSQL gives its own custom format (compressed already); everything
   * else is SQL text, gzipped here and not in the container. `all` dumps every database of the server.
   */
  async dump(
    appName: string,
    opts: { all?: boolean } = {},
    now = new Date(),
  ): Promise<DatabaseDump> {
    const { engine, container } = await this.need(appName);
    const custom = engine === 'postgres' && !opts.all;
    const mode: PostgresMode | MysqlMode =
      engine === 'postgres'
        ? opts.all
          ? 'dump-all'
          : 'dump-custom'
        : opts.all
          ? 'dump-all'
          : 'dump';
    const run = await this.docker.execStream({
      container,
      cmd: command(engine, mode),
    });

    if (!(await startedWithBytes(run.stdout))) {
      const r = await run.done;
      throw new ServiceUnavailableException(
        `The database tool wrote nothing. ${tail(r.stderr)}`.trim(),
      );
    }

    let stream: Readable = run.stdout;
    let packed: Promise<void> = Promise.resolve();
    let gz: ReturnType<typeof createGzip> | null = null;
    if (!custom) {
      gz = createGzip();
      run.stdout.pipe(gz);
      stream = gz;
      const packer = gz;
      packed = new Promise<void>((resolve) => {
        packer.once('end', () => resolve());
        packer.once('close', () => resolve());
      });
    }
    const finished = Promise.all([run.done, packed]).then(([r]) => ({
      ok: r.exitCode === 0,
      detail:
        r.exitCode === 0
          ? ''
          : `The database tool stopped with exit code ${r.exitCode}. ${tail(r.stderr)}`.trim(),
    }));
    return {
      filename: dumpFilename(appName, now, custom ? 'custom' : 'sql'),
      contentType: custom ? 'application/octet-stream' : 'application/gzip',
      stream,
      finished,
      abort: async () => {
        await run.abort();
        // A source that is destroyed does not end the stream it was piped into, so end it, or `finished` never settles
        gz?.destroy();
        await finished;
      },
    };
  }

  /**
   * Looks at the first bytes of an upload (and inside it, when it is gzip) to tell what it is. Only that look is held.
   */
  private async prepare(
    body: Readable,
  ): Promise<{ format: DumpFormat; stream: Readable }> {
    let { head, whole } = await takeHead(body, HEAD_BYTES);
    let format = detectFormat(head);
    if (format === 'gzip') {
      const gunzip = createGunzip();
      whole.on('error', (e) => gunzip.destroy(e));
      whole.pipe(gunzip);
      try {
        ({ head, whole } = await takeHead(gunzip, HEAD_BYTES));
      } catch {
        throw new ValidationError(
          'The file looks like gzip, but it cannot be unpacked.',
        );
      }
      format = detectFormat(head);
      if (format === 'gzip')
        throw new ValidationError(
          'The file is gzip inside gzip. Unpack it once and try again.',
        );
    }
    if (format === 'binary')
      throw new ValidationError(
        'This is not a dump Provelox can read: it is neither a PostgreSQL custom-format dump (pg_dump -Fc) nor SQL text, plain or gzipped.',
      );
    return { format, stream: whole };
  }

  /** Which of the engine's restore modes a file calls for, or why it cannot be restored here */
  private restoreMode(
    engine: Engine,
    format: DumpFormat,
    clean: boolean,
  ): PostgresMode | MysqlMode {
    const name =
      engine === 'postgres'
        ? 'PostgreSQL'
        : engine === 'mariadb'
          ? 'MariaDB'
          : 'MySQL';
    if (format === 'pg-custom') {
      if (engine !== 'postgres')
        throw new ValidationError(
          `This is a PostgreSQL dump, and this app runs ${name}.`,
        );
      return clean ? 'restore-custom-clean' : 'restore-custom';
    }
    if (typeof format === 'string')
      throw new ValidationError('This file is not a dump Provelox can read.');
    const { from, all } = format.sql;
    if (!compatible(engine, from))
      throw new ValidationError(
        `This SQL was written by ${from === 'postgres' ? 'PostgreSQL' : from === 'mariadb' ? 'MariaDB' : 'MySQL'}, and this app runs ${name}.`,
      );
    if (all && clean)
      throw new ValidationError(
        'This is a dump of all databases of a server, which cannot replace one database. Restore it without replacing, into a server that does not hold them yet.',
      );
    if (engine === 'postgres')
      return clean ? 'restore-sql-clean' : 'restore-sql';
    return all ? 'restore-all' : clean ? 'restore-clean' : 'restore';
  }

  /**
   * Restores a dump into the app's database while the app runs. Without `clean` it is added to what is there; with it
   * the database's contents are dropped first, which needs `confirm` to be the app's name. A restore stops at its first
   * error (the tools are told to), and says what that was. `signal` aborting stops the tool inside the container.
   */
  async restore(
    appName: string,
    body: Readable,
    opts: { clean?: boolean; confirm?: string; signal?: AbortSignal } = {},
  ): Promise<{ restored: true; bytes: number }> {
    const clean = !!opts.clean;
    if (clean && opts.confirm !== appName)
      throw new ValidationError(
        `Replacing what is in the database needs the app's name to confirm: "${appName}".`,
      );
    const { engine, container } = await this.need(appName);
    // What is counted is what was uploaded (a gzipped dump counts as the gzip), not what the tool is given after unpacking
    const counter = new ByteCounter();
    body.on('error', (e) => counter.destroy(e));
    body.pipe(counter);
    const { format, stream } = await this.prepare(counter);
    const mode = this.restoreMode(engine, format, clean);

    const run = await this.docker.execStream({
      container,
      cmd: command(engine, mode),
      input: stream,
    });
    // The tool's own output is not wanted, but it must be read or the tool would wait for it
    run.stdout.resume();
    const stop = () => void run.abort();
    opts.signal?.addEventListener('abort', stop, { once: true });
    try {
      const r = await run.done;
      if (opts.signal?.aborted)
        throw new DomainError(
          'The restore was cancelled before it finished.',
          499,
          'cancelled',
        );
      if (r.exitCode !== 0)
        throw new DomainError(
          `The restore stopped with exit code ${r.exitCode}${tail(r.stderr) ? `: ${tail(r.stderr)}` : ''}. What was restored before that point is in the database.`,
          422,
          'restore_failed',
        );
      return { restored: true, bytes: counter.count };
    } finally {
      opts.signal?.removeEventListener('abort', stop);
    }
  }
}
