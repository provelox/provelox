import { unsafeResolved, unsafeTarget } from '../common/url-safety';
import { randomBytes } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppsService } from '../apps/apps.service';
import { NotFoundError, ValidationError } from '../common/errors';
import { SecretBox } from '../common/secret-box';
import { CONFIG, type Config } from '../config/config';
import { SettingsService } from '../system/settings.service';
import {
  certificateStep,
  conditionOf,
  messageFor,
  step,
  type CertEvent,
  type CertLevel,
  type ProblemEvent,
  type Tracker,
} from './transitions';

export interface NotificationEvents {
  /** An app has kept failing, or runs with a failing health check */
  problem: boolean;
  /** An app that was reported has recovered */
  recovered: boolean;
  /** A certificate is about to expire, or has */
  certificate: boolean;
}

interface StoredWebhook {
  id: string;
  name: string;
  /** The URL, sealed: it usually carries a secret token */
  sealed: string;
  lastStatus?: string;
  lastAt?: string;
}

interface Stored {
  webhooks: StoredWebhook[];
  events: NotificationEvents;
  certLevels: Record<string, CertLevel>;
}

export interface WebhookView {
  id: string;
  name: string;
  /** Only the host: the rest of the URL is a secret and is never shown again */
  host: string;
  lastStatus?: string;
  lastAt?: string;
}

const KEY = 'notifications';
const DEFAULTS: Stored = {
  webhooks: [],
  events: { problem: true, recovered: true, certificate: true },
  certLevels: {},
};
const CERT_EVERY_MS = 60 * 60_000;

type Fetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect?: 'manual' | 'follow' | 'error';
  },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Tells people when something needs them: an app that keeps failing or has a failing health check, one that recovers,
 * a certificate about to run out. It watches on a timer and posts to the webhooks you add, in a shape Slack, Discord and
 * most chat tools accept.
 */
@Injectable()
export class NotificationsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger('Notifications');
  private readonly box: SecretBox;
  private timer?: NodeJS.Timeout;
  private readonly trackers = new Map<string, Tracker>();
  private lastCertCheck = 0;
  /** Replaced in tests */
  fetcher: Fetch = (url, init) => fetch(url, init);

  constructor(
    private readonly settings: SettingsService,
    private readonly apps: AppsService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {
    this.box = new SecretBox(cfg.JWT_SECRET, 'notifications');
  }

  onApplicationBootstrap() {
    if (this.cfg.NOTIFY_CHECK_SECONDS <= 0) return;
    this.timer = setInterval(
      () => void this.check().catch((e) => this.log.warn(`Check failed: ${e}`)),
      this.cfg.NOTIFY_CHECK_SECONDS * 1000,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private load(): Stored {
    const s = this.settings.get<Partial<Stored>>(KEY) ?? {};
    return {
      webhooks: s.webhooks ?? [],
      events: { ...DEFAULTS.events, ...(s.events ?? {}) },
      certLevels: s.certLevels ?? {},
    };
  }

  private save(s: Stored) {
    this.settings.set(KEY, s);
  }

  private viewOf(w: StoredWebhook): WebhookView {
    const url = this.box.open(w.sealed);
    let host = 'unreadable';
    try {
      if (url) host = new URL(url).host;
    } catch {
      // keep "unreadable"
    }
    return {
      id: w.id,
      name: w.name,
      host,
      lastStatus: w.lastStatus,
      lastAt: w.lastAt,
    };
  }

  view() {
    const s = this.load();
    return {
      webhooks: s.webhooks.map((w) => this.viewOf(w)),
      events: s.events,
    };
  }

  addWebhook(name: string, url: string): WebhookView {
    const clean = name.trim();
    if (!clean) throw new ValidationError('Give the webhook a name.');
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new ValidationError(
        'Enter the webhook address, like https://hooks.example.com/abc.',
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw new ValidationError(
        'The address must start with https:// or http://.',
      );
    const unsafe = unsafeTarget(parsed);
    if (unsafe) throw new ValidationError(unsafe);
    const s = this.load();
    if (s.webhooks.length >= 10)
      throw new ValidationError('Ten webhooks is the most. Remove one first.');
    const w: StoredWebhook = {
      id: randomBytes(5).toString('hex'),
      name: clean.slice(0, 60),
      sealed: this.box.seal(parsed.toString()),
    };
    s.webhooks.push(w);
    this.save(s);
    return this.viewOf(w);
  }

  /**
   * Makes the given webhooks exist and sets the events, for a hub that keeps them the same on every node. A webhook is
   * matched by name: the same name gets the new address, a new name is added. Others a node has are left alone.
   */
  sync(input: {
    events?: Partial<NotificationEvents>;
    webhooks?: { name: string; url: string }[];
  }) {
    const s = this.load();
    for (const w of input.webhooks ?? []) {
      const name = w.name.trim().slice(0, 60);
      if (!name) throw new ValidationError('Give each webhook a name.');
      let parsed: URL;
      try {
        parsed = new URL(w.url.trim());
      } catch {
        throw new ValidationError(`${name}: enter the webhook address.`);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new ValidationError(
          `${name}: the address must start with https:// or http://.`,
        );
      const unsafe = unsafeTarget(parsed);
      if (unsafe) throw new ValidationError(`${name}: ${unsafe}`);
      const have = s.webhooks.find((x) => x.name === name);
      if (have) have.sealed = this.box.seal(parsed.toString());
      else {
        if (s.webhooks.length >= 10)
          throw new ValidationError(
            'Ten webhooks is the most. Remove one on the node first.',
          );
        s.webhooks.push({
          id: randomBytes(5).toString('hex'),
          name,
          sealed: this.box.seal(parsed.toString()),
        });
      }
    }
    if (input.events) s.events = { ...s.events, ...input.events };
    this.save(s);
    return this.view();
  }

  removeWebhook(id: string) {
    const s = this.load();
    if (!s.webhooks.some((w) => w.id === id))
      throw new NotFoundError('There is no such webhook.');
    s.webhooks = s.webhooks.filter((w) => w.id !== id);
    this.save(s);
  }

  setEvents(events: Partial<NotificationEvents>) {
    const s = this.load();
    s.events = { ...s.events, ...events };
    this.save(s);
    return s.events;
  }

  /** Posts one message to one webhook and remembers how it went. */
  private async deliver(
    w: StoredWebhook,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: string }> {
    const url = this.box.open(w.sealed);
    let status: string;
    let ok = false;
    if (!url) status = 'Could not read the saved address';
    else {
      try {
        // look at where the name leads now, not only at how it is written
        const unsafe = await unsafeResolved(new URL(url));
        if (unsafe) throw new Error(unsafe);
        const res = await this.fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
          // A redirect could lead somewhere the address check never saw
          redirect: 'manual',
        });
        ok = res.ok;
        status = res.ok
          ? `Delivered (${res.status})`
          : `Refused (${res.status})`;
      } catch (e) {
        status = `Could not reach it: ${e instanceof Error ? e.message : 'unknown error'}`;
      }
    }
    const s = this.load();
    const stored = s.webhooks.find((x) => x.id === w.id);
    if (stored) {
      stored.lastStatus = status;
      stored.lastAt = new Date().toISOString();
      this.save(s);
    }
    return { ok, status };
  }

  private payload(
    kind: string,
    m: { title: string; text: string },
    extra: object = {},
  ) {
    return {
      source: 'provelox',
      event: kind,
      title: m.title,
      message: m.text,
      at: new Date().toISOString(),
      ...extra,
      // the shapes Slack and Discord read
      text: `${m.title}\n${m.text}`,
      content: `**${m.title}**\n${m.text}`,
    };
  }

  /** Sends a sample message to one webhook so you can see it arrive. */
  async test(id: string) {
    const w = this.load().webhooks.find((x) => x.id === id);
    if (!w) throw new NotFoundError('There is no such webhook.');
    return this.deliver(
      w,
      this.payload('test', {
        title: 'Provelox can reach this webhook',
        text: 'This is a test message. Real ones say when an app fails or a certificate is running out.',
      }),
    );
  }

  private async notify(e: ProblemEvent | CertEvent) {
    const s = this.load();
    const kind =
      e.type === 'certificate'
        ? 'certificate'
        : e.type === 'recovered'
          ? 'recovered'
          : 'problem';
    if (!s.events[kind]) return;
    const m = messageFor(e);
    const extra = e.type === 'certificate' ? { host: e.host } : { app: e.app };
    await Promise.all(
      s.webhooks.map((w) => this.deliver(w, this.payload(e.type, m, extra))),
    );
  }

  /** One round: how every app is doing, and now and then the certificates. Safe to call on any schedule. */
  async check(now = Date.now()) {
    const views = await this.apps.list();
    const present = new Set(views.map((v) => v.app.name));
    for (const name of [...this.trackers.keys()])
      if (!present.has(name)) this.trackers.delete(name);

    for (const v of views) {
      const r = step(v.app.name, this.trackers.get(v.app.name), conditionOf(v));
      this.trackers.set(v.app.name, r.next);
      if (r.event) await this.notify(r.event);
    }

    if (now - this.lastCertCheck < CERT_EVERY_MS) return;
    this.lastCertCheck = now;
    const s = this.load();
    let changed = false;
    for (const v of views) {
      if (!v.hosts.some((h) => h.ssl)) continue;
      const certs = await this.apps.certificates(v.app.name).catch(() => []);
      for (const c of certs) {
        const r = certificateStep(s.certLevels[c.host], c);
        if (r.level !== s.certLevels[c.host]) {
          if (r.level) s.certLevels[c.host] = r.level;
          changed = true;
        }
        if (r.event) await this.notify(r.event);
      }
    }
    if (changed) this.save({ ...this.load(), certLevels: s.certLevels });
  }
}
