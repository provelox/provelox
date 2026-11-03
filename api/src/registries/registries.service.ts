import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { SecretBox } from '../common/secret-box';
import { CONFIG, type Config } from '../config/config';
import { Db } from '../db/db';
import {
  DOCKER,
  type DockerPort,
  type RegistryAuth,
} from '../docker/docker.port';
import { normalizeRegistryDomain, registryOf } from './registry-domain';

export interface RegistryView {
  id: string;
  domain: string;
  username: string;
  createdAt: string;
}

interface Row {
  id: string;
  domain: string;
  username: string;
  sealed_password: string;
  created_at: string;
}

const input = z.object({
  domain: z
    .string()
    .trim()
    .min(1, 'Enter the registry address, like ghcr.io.')
    .max(253),
  username: z.string().trim().min(1, 'Enter the username.').max(200),
  password: z.string().min(1, 'Enter the password or access token.').max(2000),
});

/** Credentials for private registries. Passwords are stored encrypted and never returned. */
@Injectable()
export class RegistriesService implements OnModuleInit {
  private readonly box: SecretBox;

  constructor(
    private readonly db: Db,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) cfg: Config,
  ) {
    this.box = new SecretBox(cfg.JWT_SECRET, 'registries');
  }

  /**
   * The sign-in the install was given (`--registry-user`) arrives as a secret file. If Settings → Registries has no
   * entry for that registry yet, it is added, so the sign-in is visible, can be changed, and is what an update from the
   * hub uses. An entry someone made or changed in the console is never overwritten.
   */
  onModuleInit() {
    const file = process.env.REGISTRY_SEED_FILE;
    if (!file) return;
    try {
      const seed = z
        .object({
          domain: z.string().min(1),
          username: z.string().min(1),
          password: z.string().min(1),
        })
        .parse(JSON.parse(readFileSync(file, 'utf8')));
      this.seed(seed);
    } catch (e) {
      new Logger('Registries').warn(
        `Could not read the install's registry sign-in: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Adds a sign-in for a registry that has none. Returns whether it did. */
  seed(s: { domain: string; username: string; password: string }): boolean {
    const domain = normalizeRegistryDomain(s.domain);
    if (this.rows().some((r) => r.domain === domain)) return false;
    this.db.raw
      .prepare(
        'INSERT INTO registries (id, domain, username, sealed_password, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        `r_${randomBytes(5).toString('hex')}`,
        domain,
        s.username,
        this.box.seal(s.password),
        new Date().toISOString(),
      );
    return true;
  }

  private rows(): Row[] {
    return this.db.raw
      .prepare('SELECT * FROM registries ORDER BY domain')
      .all() as Row[];
  }

  private view = (r: Row): RegistryView => ({
    id: r.id,
    domain: r.domain,
    username: r.username,
    createdAt: r.created_at,
  });

  list(): RegistryView[] {
    return this.rows().map(this.view);
  }

  /** What Docker needs to pull `image`, or undefined when no stored registry matches (public pull). */
  authFor(image: string): RegistryAuth | undefined {
    if (!image) return undefined;
    const domain = registryOf(image);
    const row = this.rows().find((r) => r.domain === domain);
    if (!row) return undefined;
    const password = this.box.open(row.sealed_password);
    if (password === null) return undefined; // unreadable (the server secret changed): pull anonymously rather than crash
    return {
      username: row.username,
      password,
      // Docker Hub's API address differs from its name
      serveraddress:
        domain === 'docker.io' ? 'https://index.docker.io/v1/' : domain,
    };
  }

  /**
   * Asks the registry whether this server could pull `image` with the saved sign-in for its registry (or with none),
   * without pulling it. A login that the registry accepts can still lack access to a package, and only this finds out.
   */
  async check(raw: unknown): Promise<{
    registry: string;
    user: string | null;
    pull: { ok: true } | { ok: false; reason: string };
  }> {
    const parsed = z
      .object({ image: z.string().trim().min(1, 'Enter an image.').max(300) })
      .safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Enter an image.',
      );
    const image = parsed.data.image;
    // Anything that could change what is asked for is refused: this is an image reference and nothing else
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/.test(image))
      throw new ValidationError('That is not an image name.');
    const auth = this.authFor(image);
    return {
      registry: registryOf(image),
      user: auth?.username ?? null,
      pull: await this.docker.canPull(image, auth),
    };
  }

  private async verify(domain: string, username: string, password: string) {
    try {
      await this.docker.checkRegistryAuth({
        username,
        password,
        serveraddress:
          domain === 'docker.io' ? 'https://index.docker.io/v1/' : domain,
      });
    } catch {
      throw new ValidationError(
        'The registry rejected these credentials. Check the address, username and password.',
      );
    }
  }

  /**
   * Makes this sign-in the one for its registry, whether or not there is one already: what a hub sends to every node.
   * The registry must accept it, as with add and update.
   */
  async upsert(raw: unknown): Promise<RegistryView> {
    const parsed = input.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
      );
    const domain = normalizeRegistryDomain(parsed.data.domain);
    const have = this.rows().find((r) => r.domain === domain);
    if (!have) return this.add(raw);
    return this.update(have.id, {
      username: parsed.data.username,
      password: parsed.data.password,
    });
  }

  async add(raw: unknown): Promise<RegistryView> {
    const parsed = input.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
      );
    const domain = normalizeRegistryDomain(parsed.data.domain);
    if (this.rows().some((r) => r.domain === domain))
      throw new ConflictError(`${domain} is already added. Edit it instead.`);
    await this.verify(domain, parsed.data.username, parsed.data.password);
    const row: Row = {
      id: `r_${randomBytes(5).toString('hex')}`,
      domain,
      username: parsed.data.username,
      sealed_password: this.box.seal(parsed.data.password),
      created_at: new Date().toISOString(),
    };
    this.db.raw
      .prepare(
        'INSERT INTO registries (id, domain, username, sealed_password, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.domain,
        row.username,
        row.sealed_password,
        row.created_at,
      );
    return this.view(row);
  }

  /** Change the username and/or password. The registry address is fixed: add a new one instead. */
  async update(id: string, raw: unknown): Promise<RegistryView> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new NotFoundError('Registry not found.');
    const parsed = input
      .pick({ username: true, password: true })
      .partial()
      .strict()
      .safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
      );
    const username = parsed.data.username ?? row.username;
    const password = parsed.data.password ?? this.box.open(row.sealed_password);
    if (password === null)
      throw new ValidationError(
        'The stored password cannot be read. Enter the password again.',
      );
    await this.verify(row.domain, username, password);
    const sealed = parsed.data.password
      ? this.box.seal(parsed.data.password)
      : row.sealed_password;
    this.db.raw
      .prepare(
        'UPDATE registries SET username = ?, sealed_password = ? WHERE id = ?',
      )
      .run(username, sealed, id);
    return this.view({ ...row, username });
  }

  remove(id: string) {
    if (
      this.db.raw.prepare('DELETE FROM registries WHERE id = ?').run(id)
        .changes === 0
    )
      throw new NotFoundError('Registry not found.');
  }
}
