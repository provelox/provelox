import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { SecretBox } from '../common/secret-box';
import { CONFIG, type Config } from '../config/config';
import { Db } from '../db/db';
import type { Template } from './catalog';
import {
  fetchText,
  MAX_COMPOSE_BYTES,
  MAX_INDEX_BYTES,
  parseIndex,
  rawGitUrl,
  resolveRelative,
} from './source-index';

export type SourceKind = 'index' | 'git';

export interface SourceView {
  id: string;
  name: string;
  kind: SourceKind;
  /** The index file's address, or the repository's */
  url: string;
  ref: string | null;
  path: string | null;
  hasToken: boolean;
  createdAt: string;
  syncedAt: string | null;
  /** Why the last refresh failed; the templates from the one before are still offered */
  error: string | null;
  templates: number;
  skipped: { id: string; reason: string }[];
}

/** A template from a registry: the built-in shape, and where it came from. The id is `<registry id>:<template id>`. */
export type SourcedTemplate = Template & {
  source: { id: string; name: string };
};

interface Row {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  ref: string | null;
  path: string | null;
  sealed_token: string | null;
  created_at: string;
  synced_at: string | null;
  error: string | null;
  cache: string;
  skipped: string;
}

const STALE_MS = 6 * 3600_000;
const DEFAULT_PATH = 'provelox-templates.json';

const input = z
  .object({
    kind: z.enum(['index', 'git']),
    name: z.string().trim().max(60).optional(),
    url: z.string().trim().min(1, 'Enter an address.').max(500),
    ref: z.string().trim().max(100).optional(),
    path: z.string().trim().max(200).optional(),
    token: z.string().max(2000).optional(),
  })
  .strict();

/** Where templates come from besides the built-in ones. Each registry is an index file, kept as last read. */
@Injectable()
export class TemplateSourcesService {
  private readonly log = new Logger('TemplateSources');
  private readonly box: SecretBox;
  private readonly refreshing = new Set<string>();
  /** Replaced in tests */
  fetchImpl?: typeof fetch;

  constructor(
    private readonly db: Db,
    @Inject(CONFIG) cfg: Config,
  ) {
    this.box = new SecretBox(cfg.JWT_SECRET, 'template-sources');
  }

  private rows(): Row[] {
    return this.db.raw
      .prepare('SELECT * FROM template_sources ORDER BY name COLLATE NOCASE')
      .all() as Row[];
  }

  private row(id: string): Row {
    const r = this.db.raw
      .prepare('SELECT * FROM template_sources WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new NotFoundError('There is no such template registry.');
    return r;
  }

  private view = (r: Row): SourceView => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    url: r.url,
    ref: r.ref,
    path: r.path,
    hasToken: !!r.sealed_token,
    createdAt: r.created_at,
    syncedAt: r.synced_at,
    error: r.error,
    templates: (JSON.parse(r.cache) as unknown[]).length,
    skipped: JSON.parse(r.skipped),
  });

  list(): SourceView[] {
    return this.rows().map(this.view);
  }

  private tokenOf(r: Pick<Row, 'sealed_token'>) {
    return r.sealed_token
      ? (this.box.open(r.sealed_token) ?? undefined)
      : undefined;
  }

  /** The address of the index file for a registry as configured. */
  private indexUrl(r: Pick<Row, 'kind' | 'url' | 'ref' | 'path'>) {
    return r.kind === 'git'
      ? rawGitUrl(r.url, r.ref || 'main', r.path || DEFAULT_PATH)
      : r.url;
  }

  /** Reads the registry: its index, and the Compose file of each entry that keeps it in a file. */
  private async read(
    r: Pick<Row, 'kind' | 'url' | 'ref' | 'path'>,
    token?: string,
  ) {
    const base = this.indexUrl(r);
    const fetchImpl = this.fetchImpl;
    const text = await fetchText(base, {
      token,
      maxBytes: MAX_INDEX_BYTES,
      fetchImpl,
    });
    const parsed = parseIndex(text);
    const templates: Template[] = [];
    const skipped = [...parsed.skipped];
    for (const e of parsed.entries) {
      const { composeFile, compose, ...rest } = e;
      let body = compose;
      if (!body && composeFile) {
        try {
          body = await fetchText(resolveRelative(composeFile, base), {
            token,
            maxBytes: MAX_COMPOSE_BYTES,
            fetchImpl,
          });
        } catch (err) {
          skipped.push({
            id: e.id,
            reason: `Its compose file could not be read: ${err instanceof Error ? err.message : err}`,
          });
          continue;
        }
      }
      templates.push({ ...rest, compose: body as string });
    }
    return { name: parsed.name, templates, skipped };
  }

  async add(raw: unknown): Promise<SourceView> {
    const p = input.safeParse(raw);
    if (!p.success)
      throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid input');
    const d = p.data;
    if (this.rows().some((r) => r.url === d.url))
      throw new ConflictError('That registry is already added.');
    let read;
    try {
      read = await this.read(
        { kind: d.kind, url: d.url, ref: d.ref ?? null, path: d.path ?? null },
        d.token || undefined,
      );
    } catch (e) {
      throw new ValidationError(
        `Could not read the registry: ${e instanceof Error ? e.message : e}`,
      );
    }
    if (read.templates.length === 0)
      throw new ValidationError(
        read.skipped.length
          ? `None of its templates can be used. For example ${read.skipped[0].id}: ${read.skipped[0].reason}`
          : 'The registry lists no templates.',
      );
    const id = `ts_${randomBytes(5).toString('hex')}`;
    const host = new URL(d.url).hostname;
    this.db.raw
      .prepare(
        `INSERT INTO template_sources (id, name, kind, url, ref, path, sealed_token, created_at, synced_at, error, cache, skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        d.name || read.name || host,
        d.kind,
        d.url,
        d.kind === 'git' ? d.ref || 'main' : null,
        d.kind === 'git' ? d.path || DEFAULT_PATH : null,
        d.token ? this.box.seal(d.token) : null,
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify(read.templates),
        JSON.stringify(read.skipped),
      );
    return this.view(this.row(id));
  }

  /**
   * Makes this registry exist as described, whether or not it does already: what a hub sends to every node. A registry
   * with this address is updated (its name, branch, path, and token when one is sent); otherwise it is added. It is read
   * first, as with add, so a registry a node cannot read is refused with the reason.
   */
  async upsert(raw: unknown): Promise<SourceView> {
    const p = input.safeParse(raw);
    if (!p.success)
      throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid input');
    const d = p.data;
    const have = this.rows().find((r) => r.url === d.url);
    if (!have) return this.add(raw);
    if (have.kind !== d.kind)
      throw new ConflictError(
        `${d.url} is already added as a ${have.kind === 'git' ? 'git repository' : 'index file'}. Remove it first to change that.`,
      );
    const next = {
      kind: have.kind,
      url: have.url,
      ref: have.kind === 'git' ? (d.ref ?? have.ref ?? 'main') : null,
      path: have.kind === 'git' ? (d.path ?? have.path ?? DEFAULT_PATH) : null,
    };
    const token = d.token ? d.token : this.tokenOf(have);
    let read;
    try {
      read = await this.read(next, token);
    } catch (e) {
      throw new ValidationError(
        `Could not read the registry: ${e instanceof Error ? e.message : e}`,
      );
    }
    if (read.templates.length === 0)
      throw new ValidationError(
        read.skipped.length
          ? `None of its templates can be used. For example ${read.skipped[0].id}: ${read.skipped[0].reason}`
          : 'The registry lists no templates.',
      );
    this.db.raw
      .prepare(
        `UPDATE template_sources SET name = ?, ref = ?, path = ?, sealed_token = ?, synced_at = ?, error = NULL, cache = ?, skipped = ? WHERE id = ?`,
      )
      .run(
        d.name || have.name,
        next.ref,
        next.path,
        d.token ? this.box.seal(d.token) : have.sealed_token,
        new Date().toISOString(),
        JSON.stringify(read.templates),
        JSON.stringify(read.skipped),
        have.id,
      );
    return this.view(this.row(have.id));
  }

  /** Reads the registry again. A failure is recorded and the templates from before stay. */
  async refresh(id: string): Promise<SourceView> {
    const r = this.row(id);
    try {
      const read = await this.read(r, this.tokenOf(r));
      this.db.raw
        .prepare(
          'UPDATE template_sources SET cache = ?, skipped = ?, synced_at = ?, error = NULL WHERE id = ?',
        )
        .run(
          JSON.stringify(read.templates),
          JSON.stringify(read.skipped),
          new Date().toISOString(),
          id,
        );
    } catch (e) {
      this.db.raw
        .prepare('UPDATE template_sources SET error = ? WHERE id = ?')
        .run(e instanceof Error ? e.message : String(e), id);
    }
    return this.view(this.row(id));
  }

  remove(id: string) {
    this.row(id);
    this.db.raw.prepare('DELETE FROM template_sources WHERE id = ?').run(id);
  }

  /** Every registry's templates, as last read. Registries not read for a while are refreshed in the background. */
  all(): SourcedTemplate[] {
    const out: SourcedTemplate[] = [];
    for (const r of this.rows()) {
      if (
        !this.refreshing.has(r.id) &&
        (!r.synced_at || Date.now() - Date.parse(r.synced_at) > STALE_MS)
      ) {
        this.refreshing.add(r.id);
        void this.refresh(r.id)
          .catch((e) => this.log.warn(`Refreshing ${r.name}: ${e}`))
          .finally(() => this.refreshing.delete(r.id));
      }
      for (const t of JSON.parse(r.cache) as Template[])
        out.push({
          ...t,
          id: `${r.id}:${t.id}`,
          source: { id: r.id, name: r.name },
        });
    }
    return out;
  }

  byId(id: string): SourcedTemplate | undefined {
    return id.startsWith('ts_')
      ? this.all().find((t) => t.id === id)
      : undefined;
  }
}
