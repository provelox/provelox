import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { Db } from '../db/db';
import { AppsRepo } from '../apps/apps.repo';

export const MAX_GROUP_NAME = 40;
export const MAX_GROUPS = 100;

export interface Group {
  id: string;
  name: string;
  createdAt: string;
}

/** Collections of apps ("Shop": its API, site and portal). Console-level organisation only: Docker never sees them. */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: Db,
    private readonly apps: AppsRepo,
  ) {}

  private rows(): Group[] {
    return this.db.raw
      .prepare(
        'SELECT id, name, created_at AS createdAt FROM groups ORDER BY name COLLATE NOCASE',
      )
      .all() as Group[];
  }

  list() {
    const apps = this.apps.list();
    return this.rows().map((g) => ({
      ...g,
      apps: apps.filter((a) => a.groupId === g.id).map((a) => a.name),
    }));
  }

  exists(id: string) {
    return !!this.db.raw.prepare('SELECT 1 FROM groups WHERE id = ?').get(id);
  }

  private normalize(raw: string, exceptId?: string) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) throw new ValidationError('Give the collection a name.');
    if (name.length > MAX_GROUP_NAME)
      throw new ValidationError(
        `Collection names are at most ${MAX_GROUP_NAME} characters.`,
      );
    const clash = this.rows().find(
      (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash)
      throw new ConflictError('A collection with that name already exists.');
    return name;
  }

  create(rawName: string): Group {
    if (this.rows().length >= MAX_GROUPS)
      throw new ValidationError(
        `You can have at most ${MAX_GROUPS} collections.`,
      );
    const name = this.normalize(rawName);
    const group = {
      id: `g_${randomBytes(5).toString('hex')}`,
      name,
      createdAt: new Date().toISOString(),
    };
    this.db.raw
      .prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)')
      .run(group.id, group.name, group.createdAt);
    return group;
  }

  /** Returns the group with this name, creating it when missing. */
  ensure(rawName: string): Group {
    const name = rawName.replace(/\s+/g, ' ').trim();
    return (
      this.rows().find((g) => g.name.toLowerCase() === name.toLowerCase()) ??
      this.create(name)
    );
  }

  rename(id: string, rawName: string): Group {
    const current = this.rows().find((g) => g.id === id);
    if (!current) throw new NotFoundError('Collection not found.');
    const name = this.normalize(rawName, id);
    this.db.raw
      .prepare('UPDATE groups SET name = ? WHERE id = ?')
      .run(name, id);
    return { ...current, name };
  }

  /** Only the collection goes away: its apps are no longer in a collection and are otherwise untouched. */
  remove(id: string) {
    if (!this.exists(id)) throw new NotFoundError('Collection not found.');
    this.db.raw.transaction(() => {
      for (const app of this.apps.list().filter((a) => a.groupId === id))
        this.apps.save({ ...app, groupId: null });
      this.db.raw.prepare('DELETE FROM groups WHERE id = ?').run(id);
    })();
  }

  isEmpty(id: string) {
    return this.apps.list().every((a) => a.groupId !== id);
  }
}
