import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';
import { AppsRepo } from '../apps/apps.repo';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { unsafeResolved } from '../common/url-safety';
import { CONFIG, type Config } from '../config/config';
import { SettingsService } from '../system/settings.service';
import { normalizeCidr } from './cidr';
import {
  BUILTIN_PROVIDERS,
  providerOf,
  type CdnProvider,
  type CustomCdn,
} from './providers';

const HOUR = 3_600_000;
// AWS's full list is about 3 MB and grows; a custom feed gets the same room
const MAX_BODY = 16 * 1024 * 1024;
const MAX_CUSTOM = 20;

interface Stored {
  cidrs: string[];
  fetchedAt: string;
  /** Why the last refresh did not change anything: the saved ranges are still the ones in use */
  error?: string;
}

export const customCdn = z
  .object({
    label: z.string().trim().min(1).max(60),
    clientIpHeader: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'Use a header name, like True-Client-IP')
      .nullable()
      .default(null),
    url: z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'Use an http(s) address.')
      .optional(),
    cidrs: z.array(z.string().trim().min(1)).max(2000).optional(),
  })
  .strict()
  .refine(
    (c) => !!c.url !== !!c.cidrs,
    'Give either an address to fetch the ranges from, or the ranges themselves.',
  );

export interface CdnView {
  id: string;
  label: string;
  builtin: boolean;
  clientIpHeader: string | null;
  source: string | null;
  ranges: number;
  fetchedAt: string | null;
  error: string | null;
  apps: string[];
}

/**
 * The CDNs (or other proxies) that sit in front of Provelox's own proxy. Knows their address ranges, keeps them fresh,
 * and says which to trust (so the visitor's address survives) and which to let through (so the app cannot be reached
 * around the CDN). A failed refresh never loses the ranges already saved.
 */
@Injectable()
export class CdnService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Cdn');
  private timer?: NodeJS.Timeout;
  private listeners: ((changed: string[]) => Promise<void> | void)[] = [];
  /** Replaced in tests */
  fetchText: (url: string) => Promise<string> = (url) => this.httpGet(url);

  constructor(
    private readonly settings: SettingsService,
    private readonly repo: AppsRepo,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  onApplicationBootstrap() {
    const hours = this.cfg.CDN_REFRESH_HOURS;
    if (hours <= 0) return;
    this.timer = setInterval(() => void this.refreshAll(), hours * HOUR);
    this.timer.unref?.();
    // Soon after start, so a server that was off for days does not wait a whole period; never delays startup
    const first = setTimeout(() => void this.refreshAll(), 30_000);
    first.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Called with the ids of the providers whose ranges changed. */
  onChange(fn: (changed: string[]) => Promise<void> | void) {
    this.listeners.push(fn);
  }

  private custom(): CustomCdn[] {
    return this.settings.get<CustomCdn[]>('cdn.custom') ?? [];
  }
  private stored(): Record<string, Stored> {
    return this.settings.get<Record<string, Stored>>('cdn.ranges') ?? {};
  }

  providers(): CdnProvider[] {
    return [...BUILTIN_PROVIDERS, ...this.custom().map(providerOf)];
  }

  provider(id: string): CdnProvider | undefined {
    return this.providers().find((p) => p.id === id);
  }

  /** The ranges Provelox holds for a provider, or null when it has none yet. */
  ranges(id: string): string[] | null {
    const p = this.provider(id);
    if (!p) return null;
    if (p.fixed) return p.fixed.length > 0 ? p.fixed : null;
    return this.stored()[id]?.cidrs ?? null;
  }

  /** Every provider's saved ranges, for building routing labels. */
  rangesById(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const p of this.providers()) {
      const r = this.ranges(p.id);
      if (r) out[p.id] = r;
    }
    return out;
  }

  /** Providers some app is set to sit behind. */
  private inUse(): Map<string, string[]> {
    const used = new Map<string, string[]>();
    for (const a of this.repo.list())
      if (a.cdn)
        used.set(a.cdn.provider, [...(used.get(a.cdn.provider) ?? []), a.name]);
    return used;
  }

  /** What Traefik should keep X-Forwarded-For from: the ranges of every provider in use, plus the manual setting. */
  trustedIPs(): string[] {
    const out = new Set(this.cfg.PROXY_TRUSTED_IPS);
    for (const id of this.inUse().keys())
      for (const c of this.ranges(id) ?? []) out.add(c);
    return [...out];
  }

  view(): CdnView[] {
    const used = this.inUse();
    const stored = this.stored();
    return this.providers().map((p) => ({
      id: p.id,
      label: p.label,
      builtin: p.builtin,
      clientIpHeader: p.clientIpHeader,
      source: p.urls[0] ?? null,
      ranges: this.ranges(p.id)?.length ?? 0,
      fetchedAt: stored[p.id]?.fetchedAt ?? null,
      error: stored[p.id]?.error ?? null,
      apps: used.get(p.id) ?? [],
    }));
  }

  /** Makes sure a provider has ranges, fetching them when it has none. Throws, in words, when it cannot. */
  async ensureRanges(id: string): Promise<void> {
    const p = this.provider(id);
    if (!p) throw new ValidationError(`There is no CDN called "${id}".`);
    if (this.ranges(id)) return;
    const err = await this.refreshOne(p);
    if (err || !this.ranges(id))
      throw new ValidationError(
        `Could not get ${p.label}'s address ranges: ${err ?? 'the list is empty'}. Nothing was changed.`,
      );
  }

  /** Fetches one provider's ranges now. Returns why it failed, or null. */
  private async refreshOne(p: CdnProvider): Promise<string | null> {
    const stored = this.stored();
    if (p.fixed) return null;
    try {
      const bodies = await Promise.all(p.urls.map((u) => this.fetchText(u)));
      const cidrs = p.parse(bodies);
      if (cidrs.length === 0) throw new Error('the list is empty');
      const before = stored[p.id]?.cidrs ?? [];
      // A list that suddenly shrinks to a fraction is more likely a broken feed than a real change
      if (before.length >= 4 && cidrs.length < before.length / 2)
        throw new Error(
          `the list shrank from ${before.length} to ${cidrs.length} ranges, so it was not used`,
        );
      stored[p.id] = {
        cidrs: cidrs.sort(),
        fetchedAt: new Date().toISOString(),
      };
      this.settings.set('cdn.ranges', stored);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      if (stored[p.id]) {
        stored[p.id] = { ...stored[p.id], error: msg };
        this.settings.set('cdn.ranges', stored);
      }
      return msg;
    }
  }

  /**
   * Refreshes the ranges of the providers apps use (or one provider) and, when any changed, tells whoever applies
   * them. Never throws: a provider that is down keeps its last good ranges.
   */
  async refreshAll(
    only?: string,
  ): Promise<{ changed: string[]; failed: { id: string; error: string }[] }> {
    const changed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const ids = only ? [only] : [...this.inUse().keys()];
    for (const id of ids) {
      const p = this.provider(id);
      if (!p || p.fixed) continue;
      const before = (this.ranges(id) ?? []).join(',');
      const err = await this.refreshOne(p);
      if (err) {
        failed.push({ id, error: err });
        this.log.warn(`Could not refresh ${p.label}'s ranges: ${err}`);
      } else if ((this.ranges(id) ?? []).join(',') !== before) changed.push(id);
    }
    if (changed.length > 0) await this.notify(changed);
    return { changed, failed };
  }

  /** Something that decides what is trusted or let through changed (a provider's ranges, or which apps use one). */
  async notify(changed: string[]) {
    for (const fn of this.listeners)
      try {
        await fn(changed);
      } catch (e) {
        this.log.error(
          `Applying new ranges failed: ${e instanceof Error ? e.message : e}`,
        );
      }
  }

  async saveCustom(id: string, raw: unknown): Promise<CdnView> {
    if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(id))
      throw new ValidationError(
        'Use lowercase letters, numbers and dashes for the id.',
      );
    if (BUILTIN_PROVIDERS.some((p) => p.id === id))
      throw new ConflictError(`"${id}" is built in and cannot be changed.`);
    const parsed = customCdn.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid CDN',
      );
    const c = parsed.data;
    let cidrs: string[] | undefined;
    if (c.cidrs) {
      cidrs = c.cidrs.map((r) => {
        const n = normalizeCidr(r);
        if (!n)
          throw new ValidationError(`"${r.slice(0, 60)}" is not an IP range.`);
        return n;
      });
    }
    const list = this.custom().filter((x) => x.id !== id);
    if (list.length >= MAX_CUSTOM)
      throw new ValidationError(`At most ${MAX_CUSTOM} custom CDNs.`);
    const entry: CustomCdn = {
      id,
      label: c.label,
      clientIpHeader: c.clientIpHeader,
      url: c.url,
      cidrs,
    };
    const keep = this.stored();
    delete keep[id];
    this.settings.set('cdn.ranges', keep);
    this.settings.set('cdn.custom', [...list, entry]);
    const p = this.provider(id) as CdnProvider;
    if (p.urls.length > 0)
      await this.ensureRanges(id).catch((e) => {
        // the definition is saved only when its ranges can be had
        this.settings.set('cdn.custom', list);
        throw e;
      });
    await this.notify([id]);
    return this.view().find((v) => v.id === id) as CdnView;
  }

  async removeCustom(id: string) {
    const list = this.custom();
    if (!list.some((c) => c.id === id))
      throw new NotFoundError(`No CDN called "${id}".`);
    const users = this.inUse().get(id);
    if (users?.length)
      throw new ConflictError(
        `${users.join(', ')} ${users.length === 1 ? 'is' : 'are'} set to sit behind it. Change that first.`,
      );
    this.settings.set(
      'cdn.custom',
      list.filter((c) => c.id !== id),
    );
    const keep = this.stored();
    delete keep[id];
    this.settings.set('cdn.ranges', keep);
  }

  private async httpGet(raw: string): Promise<string> {
    const url = new URL(raw);
    const unsafe = await unsafeResolved(url);
    if (unsafe) throw new Error(unsafe);
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'provelox' },
    }).catch((e: unknown) => {
      // fetch says only "fetch failed"; the reason (refused, no such host, timed out) is on its cause
      const cause = (e as { cause?: { code?: string; message?: string } })
        .cause;
      const why =
        e instanceof Error && e.name === 'TimeoutError'
          ? 'timed out'
          : (cause?.code ??
            cause?.message ??
            (e instanceof Error ? e.message : 'failed'));
      throw new Error(`could not reach ${url.host} (${why})`);
    });
    if (!res.ok) throw new Error(`${url.hostname} answered ${res.status}`);
    // Read it in pieces so a feed that never ends cannot fill memory
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error('the list is too large');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text;
  }
}
