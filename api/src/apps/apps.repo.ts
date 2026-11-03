import { Injectable } from '@nestjs/common';
import { Db } from '../db/db';
import { appDefinition, type AppDefinition } from './app.model';

/** Persistence for app definitions (the desired state). */
@Injectable()
export class AppsRepo {
  constructor(private readonly db: Db) {}

  list(): AppDefinition[] {
    const rows = this.db.raw
      .prepare('SELECT doc FROM apps ORDER BY name')
      .all() as { doc: string }[];
    return rows.map((r) => appDefinition.parse(JSON.parse(r.doc)));
  }

  get(name: string): AppDefinition | undefined {
    const row = this.db.raw
      .prepare('SELECT doc FROM apps WHERE name = ?')
      .get(name) as { doc: string } | undefined;
    return row ? appDefinition.parse(JSON.parse(row.doc)) : undefined;
  }

  save(app: AppDefinition) {
    this.db.raw
      .prepare(
        `INSERT INTO apps (name, doc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
      )
      .run(app.name, JSON.stringify(app), new Date().toISOString());
  }

  delete(name: string): boolean {
    return (
      this.db.raw.prepare('DELETE FROM apps WHERE name = ?').run(name).changes >
      0
    );
  }

  /**
   * Moves an app to a new name along with the records that are keyed by it (deploy keys, usage history), all or nothing.
   * `next` is the definition under its new name.
   */
  rename(from: string, next: AppDefinition) {
    this.db.raw.transaction(() => {
      this.delete(from);
      this.save(next);
      this.db.raw
        .prepare('UPDATE ci_keys SET app = ? WHERE app = ?')
        .run(next.name, from);
      this.db.raw
        .prepare('UPDATE usage_samples SET app = ? WHERE app = ?')
        .run(next.name, from);
    })();
  }

  byProject(project: string): AppDefinition[] {
    return this.list().filter((a) => a.project === project);
  }
}
