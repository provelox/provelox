import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { Db } from '../db/db';
import type { TokenScope } from './scope.decorator';

export interface AccessTokenView {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Row {
  id: string;
  name: string;
  scope: TokenScope;
  secret_hash: string;
  created_at: string;
  last_used_at: string | null;
}

export const TOKEN_PREFIX = 'pvxt_';
const TOKEN_RE = /^pvxt_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const MAX_FAILURES = 20;
const WINDOW_MS = 60_000;
const USE_RECORD_MS = 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Tokens for other systems (a monitoring hub, a script) that need to look at, or operate, this instance without the
 * admin password. Shown once when created; only a hash is stored. Revoking one cuts it off at once.
 */
@Injectable()
export class AccessTokensService {
  private failures = new Map<string, number[]>();
  private lastRecorded = new Map<string, number>();

  constructor(private readonly db: Db) {}

  private view = (r: Row): AccessTokenView => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  });

  list(): AccessTokenView[] {
    return (
      this.db.raw
        .prepare('SELECT * FROM access_tokens ORDER BY created_at DESC')
        .all() as Row[]
    ).map(this.view);
  }

  /** The returned `token` is shown to the user exactly once. */
  create(
    rawName: string,
    scope: TokenScope,
  ): { token: string; info: AccessTokenView } {
    const name = rawName.trim();
    if (!name) throw new ValidationError('Give the token a name.');
    if (name.length > 60)
      throw new ValidationError('Token names are at most 60 characters.');
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const row: Row = {
      id,
      name,
      scope,
      secret_hash: sha(secret).toString('hex'),
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    this.db.raw
      .prepare(
        'INSERT INTO access_tokens (id, name, scope, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.name, row.scope, row.secret_hash, row.created_at);
    return { token: `${TOKEN_PREFIX}${id}_${secret}`, info: this.view(row) };
  }

  revoke(id: string) {
    if (
      this.db.raw.prepare('DELETE FROM access_tokens WHERE id = ?').run(id)
        .changes === 0
    )
      throw new NotFoundError('Token not found.');
  }

  /** Checks a bearer token. Every failure looks the same, and repeated failures from one address are slowed down. */
  authenticate(
    token: string,
    client: string,
    now = Date.now(),
  ): AccessTokenView {
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
      throw new UnauthorizedError('Invalid token');
    };
    const m = TOKEN_RE.exec(token);
    if (!m) return fail();
    const row = this.db.raw
      .prepare('SELECT * FROM access_tokens WHERE id = ?')
      .get(m[1]) as Row | undefined;
    // compare even when the id is unknown, so timing does not reveal which ids exist
    const expected = row
      ? Buffer.from(row.secret_hash, 'hex')
      : Buffer.alloc(32);
    if (!timingSafeEqual(sha(m[2]), expected) || !row) return fail();
    this.recordUse(row.id, now);
    return this.view(row);
  }

  /** At most once a minute per token: a hub polling every few seconds should not write to the database each time. */
  private recordUse(id: string, now: number) {
    if (now - (this.lastRecorded.get(id) ?? 0) < USE_RECORD_MS) return;
    this.lastRecorded.set(id, now);
    this.db.raw
      .prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date(now).toISOString(), id);
  }
}
