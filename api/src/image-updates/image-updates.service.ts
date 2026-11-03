import { Inject, Injectable } from '@nestjs/common';
import { AppsRepo } from '../apps/apps.repo';
import { serviceName } from '../common/naming';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { RegistriesService } from '../registries/registries.service';
import { SettingsService } from '../system/settings.service';
import { displayRef, parseImageRef, type ImageRef } from './image-ref';
import { RegistryClient, type RegistryCreds } from './registry-client';
import { comparable, newestTag, type Kind } from './version-tags';

export interface ImageUpdate {
  app: string;
  /** What is deployed, written the short way */
  image: string;
  tag: string | null;
  /** A higher version of the same kind of tag, when there is one */
  latest: { tag: string; kind: Kind } | null;
  /** The registry now has a different build under the tag this app runs */
  rebuilt: boolean;
  /** When the registry was last asked, or null if it has not been yet */
  checkedAt: string | null;
  /** Why it could not be checked */
  error: string | null;
}

export interface ImageUpdatesReport {
  updates: ImageUpdate[];
  /** A check is running now; the answer will fill in */
  checking: boolean;
}

interface Entry {
  at: number;
  ok: boolean;
  error?: string;
  latest?: { tag: string; kind: Kind } | null;
  /** The digest the registry gave the tag when it was checked */
  digest?: string | null;
}

/** An answer is reused this long: registries rate-limit, and a new release is not an emergency. */
export const FRESH_MS = 6 * 3600_000;
/** A failure is tried again sooner, but not at every page load. */
export const RETRY_MS = 30 * 60_000;
/** Forcing a check again is ignored inside this. */
export const FORCE_EVERY_MS = 60_000;
const CONCURRENCY = 3;
const KEY = 'imageChecks';

const keyOf = (r: ImageRef) => `${r.registry}/${r.repo}:${r.tag}`;

/**
 * Whether a newer image exists for what each app runs, from the registry the image came from. Answers come from a
 * cache that is kept in the database, so a page load never waits on a registry and a restart does not forget: stale
 * entries are refreshed behind the request. Both a higher version tag and a rebuilt tag (same name, new content) are
 * reported. Only metadata is read, with the sign-in the server already holds for that registry.
 */
@Injectable()
export class ImageUpdatesService {
  private cache: Record<string, Entry> | null = null;
  private running: Promise<void> | null = null;
  private lastForce = 0;

  constructor(
    private readonly apps: AppsRepo,
    private readonly settings: SettingsService,
    private readonly registries: RegistriesService,
    @Inject(DOCKER) private readonly docker: DockerPort,
    private readonly client: RegistryClient = new RegistryClient(),
  ) {}

  private entries(): Record<string, Entry> {
    this.cache ??= this.settings.get<Record<string, Entry>>(KEY) ?? {};
    return this.cache;
  }

  private credsFor(image: string): RegistryCreds | undefined {
    const a = this.registries.authFor(image);
    return a ? { username: a.username, password: a.password } : undefined;
  }

  /** Every image in use that can be checked: it has a tag. Apps on the same image share one check. */
  private targets() {
    const out = new Map<string, { ref: ImageRef; image: string }>();
    for (const app of this.apps.list()) {
      const ref = app.image ? parseImageRef(app.image) : null;
      if (ref?.tag) out.set(keyOf(ref), { ref, image: app.image });
    }
    return out;
  }

  private stale(e: Entry | undefined, now: number) {
    return !e || now - e.at > (e.ok ? FRESH_MS : RETRY_MS);
  }

  /**
   * The answer from the cache, at once. Whatever is missing or old is checked behind this call, and `checking` says
   * so, so the caller can ask again in a moment.
   */
  async report(now = Date.now()): Promise<ImageUpdatesReport> {
    const targets = this.targets();
    const entries = this.entries();
    if ([...targets.keys()].some((k) => this.stale(entries[k], now)))
      void this.refresh(now);
    const running = await this.docker
      .serviceImages()
      .catch(() => ({}) as Record<string, string>);
    const updates: ImageUpdate[] = [];
    for (const app of this.apps.list()) {
      const ref = app.image ? parseImageRef(app.image) : null;
      if (!ref?.tag) continue;
      const e = entries[keyOf(ref)];
      const deployed = running[serviceName(app.name)]?.split('@')[1];
      updates.push({
        app: app.name,
        image: displayRef(ref),
        tag: ref.tag,
        latest: e?.ok ? (e.latest ?? null) : null,
        rebuilt: !!(e?.ok && e.digest && deployed && e.digest !== deployed),
        checkedAt: e ? new Date(e.at).toISOString() : null,
        error: e && !e.ok ? (e.error ?? 'Could not check') : null,
      });
    }
    return { updates, checking: this.running !== null };
  }

  /** Asks again now, whatever is cached. At most once a minute: a second call inside it only reports. */
  async force(now = Date.now()): Promise<ImageUpdatesReport> {
    if (now - this.lastForce >= FORCE_EVERY_MS) {
      this.lastForce = now;
      const entries = this.entries();
      for (const k of this.targets().keys()) if (entries[k]) entries[k].at = 0;
      void this.refresh(now);
    }
    return this.report(now);
  }

  /** Checks what is missing or old, a few at a time. One run at a time. */
  refresh(now = Date.now()): Promise<void> {
    this.running ??= this.run(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(now: number) {
    const entries = this.entries();
    const targets = [...this.targets()].filter(([k]) =>
      this.stale(entries[k], now),
    );
    // A repository's tags are listed once, however many tags of it are in use
    const tagLists = new Map<string, Promise<string[]>>();
    const queue = [...targets];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const [key, { ref, image }] = t;
        const creds = this.credsFor(image);
        try {
          const repoKey = `${ref.registry}/${ref.repo}`;
          // A tag with no version in it has nothing to compare, so the (long) list of tags is not asked for
          if (comparable(ref.tag!) && !tagLists.has(repoKey))
            tagLists.set(repoKey, this.client.tags(ref, creds));
          const [tags, digest] = await Promise.all([
            tagLists.get(repoKey) ?? Promise.resolve([] as string[]),
            this.client.digest(ref, ref.tag!, creds),
          ]);
          entries[key] = {
            at: Date.now(),
            ok: true,
            latest: newestTag(ref.tag!, tags),
            digest,
          };
        } catch (e) {
          entries[key] = {
            at: Date.now(),
            ok: false,
            error: e instanceof Error ? e.message : 'Could not check',
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
    );
    // Keep only what is in use, so the cache does not grow with every image ever deployed
    const live = new Set(this.targets().keys());
    for (const k of Object.keys(entries)) if (!live.has(k)) delete entries[k];
    this.settings.set(KEY, entries);
  }
}
