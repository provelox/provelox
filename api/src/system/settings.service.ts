import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { Db } from '../db/db';

/** Small key/value store for platform-wide settings. Values are JSON. */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  get<T>(key: string): T | undefined {
    const row = this.db.raw
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown) {
    this.db.raw
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  delete(key: string) {
    this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /**
   * Pages the proxy shows for every app that has none of its own, and for an address no app answers to (404). Missing
   * ones fall back to Provelox's built-in pages. Set from the hub to give a whole fleet the same pages.
   */
  errorPages(): Partial<Record<'404' | '502' | '503' | '504', string>> {
    return this.get('errorPages') ?? {};
  }

  setErrorPages(pages: Partial<Record<'404' | '502' | '503' | '504', string>>) {
    if (Object.keys(pages).length === 0) this.delete('errorPages');
    else this.set('errorPages', pages);
  }

  /** Let's Encrypt account email: a runtime setting wins over the environment default. */
  acmeEmail(): string | null {
    return this.get<string>('acmeEmail') ?? this.cfg.ACME_EMAIL ?? null;
  }

  /** The domain apps are served under. A runtime setting wins over the environment default. */
  rootDomain(): string | null {
    return this.get<string>('rootDomain') ?? this.cfg.ROOT_DOMAIN ?? null;
  }

  /** The domain set aside for apps, when it is not the root domain. Null: apps share the root domain. */
  appsDomainOverride(): string | null {
    return this.get<string>('appsDomain') ?? null;
  }

  /** The domain apps' default addresses are under (<app>.<this>): the apps domain, else the root domain. */
  appsDomain(): string | null {
    return this.appsDomainOverride() ?? this.rootDomain();
  }

  /**
   * Whether a new app is served at <app>.<root domain> unless its creator says otherwise. On by default; turn it off
   * to keep apps off a default address (each app can still choose either way). Existing apps are never changed.
   */
  defaultSubdomainForNewApps(): boolean {
    return this.get<boolean>('defaultSubdomainForNewApps') ?? false;
  }

  /** Whether this server may look for newer releases (on unless an admin turned it off; the environment can forbid it too) */
  updateCheck(): boolean {
    return this.get<boolean>('updateCheck') ?? true;
  }
}
