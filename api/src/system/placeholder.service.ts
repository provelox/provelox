import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ValidationError } from '../common/errors';
import { LABEL_APP } from '../common/naming';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { placeholderPage } from '../pages/brand-pages';
import { SettingsService } from './settings.service';

export const MAX_PLACEHOLDER_BYTES = 100 * 1024;
const CONFIG_PREFIX = 'pvx-placeholder-';

export const DEFAULT_PLACEHOLDER_HTML = placeholderPage();

export const PLACEHOLDER_NGINX_CONF_PATH = '/etc/nginx/conf.d/default.conf';
export const PLACEHOLDER_NGINX_CONF = `server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  location / {
    index index.html;
    add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "no-store" always;
  }
}
`;

const POLICY =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:; font-src data: https:">';

/**
 * The page is written by whoever may set it and shown at every undeployed app's address, so it is sent with a policy
 * that allows styling and images but no script. Put first so nothing before it can run.
 */
export function withPolicy(html: string): string {
  // the opening tag of <head> itself, not <header> or a tag that only begins the same way
  const head = html.match(/<head(?:\s[^>]*)?>/i);
  return head
    ? html.replace(head[0], `${head[0]}${POLICY}`)
    : `${POLICY}${html}`;
}

/** The page an app shows before its first deploy, delivered as a Swarm config mounted into the placeholder image. */
@Injectable()
export class PlaceholderService {
  private current: { id: string; name: string } | null = null;

  constructor(
    private readonly settings: SettingsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
  ) {}

  html(): string {
    return (
      this.settings.get<string>('placeholderPageHtml') ||
      DEFAULT_PLACEHOLDER_HTML
    );
  }

  isCustom(): boolean {
    return !!this.settings.get<string>('placeholderPageHtml');
  }

  /** The config for the current page, created on first use. The name carries a content hash, so it never changes in place. */
  async ensure(): Promise<{ id: string; name: string }> {
    const html = withPolicy(this.html());
    const name = `${CONFIG_PREFIX}${createHash('sha256').update(html).digest('hex').slice(0, 12)}`;
    if (this.current?.name === name) return this.current;
    this.current = await this.docker.ensureConfig(name, html, {
      [LABEL_APP]: 'placeholder',
    });
    return this.current;
  }

  /**
   * The web server's own settings for the placeholder image: the page is sent with a policy that allows styling and
   * images but no script, as a header, which cannot be dodged the way a tag inside the page can. A constant, so the same
   * Swarm config serves every undeployed app.
   */
  async ensureConf(): Promise<{ id: string; name: string }> {
    const name = `pvx-phconf-${createHash('sha256').update(PLACEHOLDER_NGINX_CONF).digest('hex').slice(0, 12)}`;
    return this.docker.ensureConfig(name, PLACEHOLDER_NGINX_CONF, {
      [LABEL_APP]: 'placeholder',
    });
  }

  /** Stores a new page (empty restores the default). Apps still on the placeholder need re-applying afterwards. */
  async set(html: string): Promise<void> {
    if (Buffer.byteLength(html) > MAX_PLACEHOLDER_BYTES)
      throw new ValidationError('The page can be at most 100 KB.');
    if (html.trim()) this.settings.set('placeholderPageHtml', html);
    else this.settings.delete('placeholderPageHtml');
    await this.ensure();
  }

  /** Drops older page configs once no service uses them any more. */
  async prune(): Promise<void> {
    if (this.current)
      await this.docker.pruneConfigs(CONFIG_PREFIX, [this.current.name]);
  }
}
