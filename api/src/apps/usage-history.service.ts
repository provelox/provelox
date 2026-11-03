import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { Db } from '../db/db';
import { AppsService } from './apps.service';

export interface UsagePoint {
  /** Epoch milliseconds: the middle of the span it summarises */
  t: number;
  cpu: number;
  mem: number;
}

const MAX_POINTS = 120;

/**
 * Keeps what each running app used over the last day, so a trend survives a page reload and an overnight spike can be
 * seen after the fact. A sample is the same reading the apps list shows, taken on a timer.
 */
@Injectable()
export class UsageHistoryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger('UsageHistory');
  private timer?: NodeJS.Timeout;
  private lastPrune = 0;

  constructor(
    private readonly db: Db,
    private readonly apps: AppsService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  onApplicationBootstrap() {
    if (this.cfg.USAGE_SAMPLE_SECONDS <= 0) return;
    this.timer = setInterval(
      () =>
        void this.sample().catch((e) => this.log.warn(`Sampling failed: ${e}`)),
      this.cfg.USAGE_SAMPLE_SECONDS * 1000,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Reads every running app once and stores it. Old samples are dropped about once an hour. */
  async sample(now = Date.now()) {
    const reading = await this.apps.usageAll();
    const insert = this.db.raw.prepare(
      'INSERT INTO usage_samples (app, at, cpu, mem) VALUES (?, ?, ?, ?)',
    );
    this.db.raw.transaction(() => {
      for (const [app, u] of Object.entries(reading))
        insert.run(app, now, u.cpuPercent, u.memoryBytes);
    })();
    if (now - this.lastPrune > 3_600_000) {
      this.lastPrune = now;
      this.prune(now);
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.cfg.USAGE_RETENTION_HOURS * 3_600_000;
    this.db.raw.prepare('DELETE FROM usage_samples WHERE at < ?').run(cutoff);
    // an app that was deleted leaves nothing behind
    this.db.raw
      .prepare(
        'DELETE FROM usage_samples WHERE app NOT IN (SELECT name FROM apps)',
      )
      .run();
  }

  /**
   * The app's samples over the last `minutes`, averaged into at most 120 points however long the span, oldest
   * first. An app with no samples (new, stopped, or the history is off) gives an empty list.
   */
  history(app: string, minutes: number, now = Date.now()): UsagePoint[] {
    const span = Math.min(
      Math.max(Math.floor(minutes), 1),
      this.cfg.USAGE_RETENTION_HOURS * 60,
    );
    const from = now - span * 60_000;
    const rows = this.db.raw
      .prepare(
        'SELECT at, cpu, mem FROM usage_samples WHERE app = ? AND at >= ? ORDER BY at',
      )
      .all(app, from) as { at: number; cpu: number; mem: number }[];
    if (rows.length === 0) return [];
    const bucket = Math.max(1, Math.ceil((span * 60_000) / MAX_POINTS));
    const out = new Map<
      number,
      { n: number; t: number; cpu: number; mem: number }
    >();
    for (const r of rows) {
      const k = Math.floor((r.at - from) / bucket);
      const b = out.get(k) ?? { n: 0, t: 0, cpu: 0, mem: 0 };
      b.n++;
      b.t += r.at;
      b.cpu += r.cpu;
      b.mem += r.mem;
      out.set(k, b);
    }
    return [...out.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => ({
        t: Math.round(b.t / b.n),
        cpu: Math.round((b.cpu / b.n) * 10) / 10,
        mem: Math.round(b.mem / b.n),
      }));
  }
}
