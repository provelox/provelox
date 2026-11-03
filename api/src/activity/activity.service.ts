import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { Db } from '../db/db';
import type { Actor } from './actor';

export interface ActivityInput {
  actor: Actor;
  action: string;
  target: string | null;
  outcome: 'ok' | 'failed';
  status: number;
  summary: string;
}

export interface ActivityEvent {
  id: number;
  at: string;
  actor: Actor;
  action: string;
  target: string | null;
  outcome: 'ok' | 'failed';
  status: number;
  summary: string;
}

export interface ActivityQuery {
  /** Events about this app, collection or project */
  app?: string;
  /** An action or the start of one: "app", "app.deploy", "secret" */
  action?: string;
  /** The actor's name */
  actor?: string;
  outcome?: 'ok' | 'failed';
  /** Only events at or after this time (ISO) */
  since?: string;
  /** Only events older than this one: the cursor for the next page */
  before?: number;
  limit?: number;
}

interface Row {
  id: number;
  at: string;
  actor_kind: Actor['kind'];
  actor_name: string;
  actor_scope: string | null;
  actor_app: string | null;
  action: string;
  target: string | null;
  outcome: 'ok' | 'failed';
  status: number;
  summary: string;
}

const PRUNE_EVERY = 200;
const HOUR = 3_600_000;

/**
 * The activity log: one row for each change someone made through the API. Kept in the API's own database, pruned by age
 * and by count, and written after the answer has gone so it can never slow a request or fail one.
 */
@Injectable()
export class ActivityService implements OnModuleDestroy {
  private readonly log = new Logger('Activity');
  private writes = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {
    this.prune();
    // Sweeps by age even when nothing is being written; never keeps the process alive
    this.timer = setInterval(() => this.prune(), HOUR);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Never throws: a failure to log must not become a failure of the request that was logged. */
  record(e: ActivityInput, now = new Date()) {
    try {
      this.db.raw
        .prepare(
          `INSERT INTO activity (at, actor_kind, actor_name, actor_scope, actor_app, action, target, outcome, status, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          now.toISOString(),
          e.actor.kind,
          e.actor.name,
          e.actor.scope ?? null,
          e.actor.app ?? null,
          e.action,
          e.target,
          e.outcome,
          e.status,
          e.summary,
        );
      if (++this.writes % PRUNE_EVERY === 0) this.prune(now);
    } catch (err) {
      this.log.warn(`Could not record an activity event: ${String(err)}`);
    }
  }

  list(q: ActivityQuery = {}): {
    events: ActivityEvent[];
    next: number | null;
  } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.app) {
      where.push('target = ?');
      args.push(q.app);
    }
    if (q.action) {
      // A prefix on a whole word: "app" matches "app.deploy" but not "application"
      where.push("(action = ? OR action LIKE ? ESCAPE '\\')");
      args.push(q.action, `${q.action.replace(/[\\%_]/g, '\\$&')}.%`);
    }
    if (q.actor) {
      where.push('actor_name = ?');
      args.push(q.actor);
    }
    if (q.outcome) {
      where.push('outcome = ?');
      args.push(q.outcome);
    }
    if (q.since) {
      where.push('at >= ?');
      args.push(q.since);
    }
    if (q.before) {
      where.push('id < ?');
      args.push(q.before);
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as Row[];
    const page = rows.slice(0, limit).map(toEvent);
    return {
      events: page,
      next: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Who has acted, for the console's filter */
  actors(): string[] {
    return (
      this.db.raw
        .prepare('SELECT DISTINCT actor_name FROM activity ORDER BY actor_name')
        .all() as { actor_name: string }[]
    ).map((r) => r.actor_name);
  }

  /** Drops what is older than the retention and what is beyond the cap, oldest first. */
  prune(now = new Date()) {
    try {
      const cutoff = new Date(
        now.getTime() - this.cfg.ACTIVITY_RETENTION_DAYS * 86_400_000,
      ).toISOString();
      this.db.raw.prepare('DELETE FROM activity WHERE at < ?').run(cutoff);
      const top = this.db.raw
        .prepare('SELECT MAX(id) AS id FROM activity')
        .get() as { id: number | null };
      if (top.id)
        this.db.raw
          .prepare('DELETE FROM activity WHERE id <= ?')
          .run(top.id - this.cfg.ACTIVITY_MAX_EVENTS);
    } catch (err) {
      this.log.warn(`Could not prune the activity log: ${String(err)}`);
    }
  }
}

const toEvent = (r: Row): ActivityEvent => ({
  id: r.id,
  at: r.at,
  actor: {
    kind: r.actor_kind,
    name: r.actor_name,
    ...(r.actor_scope ? { scope: r.actor_scope } : {}),
    ...(r.actor_app ? { app: r.actor_app } : {}),
  },
  action: r.action,
  target: r.target,
  outcome: r.outcome,
  status: r.status,
  summary: r.summary,
});
