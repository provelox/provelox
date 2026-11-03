import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { Db } from '../db/db';

export interface CiKeyView {
  id: string;
  name: string;
  app: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedImage: string | null;
}

interface Row {
  id: string;
  name: string;
  app: string;
  secret_hash: string;
  created_at: string;
  last_used_at: string | null;
  last_used_image: string | null;
}

const KEY_RE = /^pvxk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const MAX_FAILURES = 20;
const WINDOW_MS = 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Deploy keys for pipelines. A key can deploy one app and nothing else, is shown once when created, and only a
 * hash of it is stored.
 */
@Injectable()
export class CiKeysService {
  private failures = new Map<string, number[]>();

  constructor(private readonly db: Db) {}

  private view = (r: Row): CiKeyView => ({
    id: r.id,
    name: r.name,
    app: r.app,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    lastUsedImage: r.last_used_image,
  });

  list(app?: string): CiKeyView[] {
    const rows = (
      app
        ? this.db.raw
            .prepare(
              'SELECT * FROM ci_keys WHERE app = ? ORDER BY created_at DESC',
            )
            .all(app)
        : this.db.raw
            .prepare('SELECT * FROM ci_keys ORDER BY created_at DESC')
            .all()
    ) as Row[];
    return rows.map(this.view);
  }

  /** The caller must have checked that the app exists. The returned `key` is shown to the user exactly once. */
  create(app: string, rawName: string): { key: string; info: CiKeyView } {
    const name = rawName.trim();
    if (!name) throw new ValidationError('Give the key a name.');
    if (name.length > 60)
      throw new ValidationError('Key names are at most 60 characters.');
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const row: Row = {
      id,
      name,
      app,
      secret_hash: sha(secret).toString('hex'),
      created_at: new Date().toISOString(),
      last_used_at: null,
      last_used_image: null,
    };
    this.db.raw
      .prepare(
        'INSERT INTO ci_keys (id, name, app, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.name, row.app, row.secret_hash, row.created_at);
    return { key: `pvxk_${id}_${secret}`, info: this.view(row) };
  }

  revoke(id: string) {
    if (
      this.db.raw.prepare('DELETE FROM ci_keys WHERE id = ?').run(id)
        .changes === 0
    )
      throw new NotFoundError('Key not found.');
  }

  removeForApp(app: string) {
    this.db.raw.prepare('DELETE FROM ci_keys WHERE app = ?').run(app);
  }

  /**
   * Checks an `Authorization: Bearer pvxk_...` header. Every failure looks the same, and repeated failures from one
   * address are slowed down.
   */
  authenticate(
    header: string | undefined,
    client: string,
    now = Date.now(),
  ): CiKeyView {
    const recent = (this.failures.get(client) ?? []).filter(
      (t) => now - t < WINDOW_MS,
    );
    if (recent.length === 0) this.failures.delete(client);
    else this.failures.set(client, recent);
    if (recent.length >= MAX_FAILURES)
      throw new TooManyRequestsError(
        'Too many failed attempts. Try again in a minute.',
      );

    const fail = (): never => {
      recent.push(now);
      // only clients that have failed are kept, and never more than a few thousand
      if (!this.failures.has(client) && this.failures.size >= 2000)
        this.failures.clear();
      this.failures.set(client, recent);
      throw new UnauthorizedError('Invalid API key');
    };
    const [scheme, token] = (header ?? '').split(' ');
    const m =
      scheme?.toLowerCase() === 'bearer' && token ? KEY_RE.exec(token) : null;
    if (!m) return fail();
    const row = this.db.raw
      .prepare('SELECT * FROM ci_keys WHERE id = ?')
      .get(m[1]) as Row | undefined;
    // compare even when the key id is unknown, so timing does not reveal which ids exist
    const expected = row
      ? Buffer.from(row.secret_hash, 'hex')
      : Buffer.alloc(32);
    const ok = timingSafeEqual(sha(m[2]), expected) && !!row;
    if (!ok || !row) return fail();
    return this.view(row);
  }

  recordUse(id: string, image: string) {
    this.db.raw
      .prepare(
        'UPDATE ci_keys SET last_used_at = ?, last_used_image = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), image, id);
  }
}
