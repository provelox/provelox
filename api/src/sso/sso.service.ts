import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppsRepo } from '../apps/apps.repo';
import type { AppDefinition } from '../apps/app.model';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { SecretBox } from '../common/secret-box';
import { CONFIG, type Config } from '../config/config';
import { hostsOf } from '../proxy/traefik-labels';
import { SettingsService } from '../system/settings.service';
import {
  discoveryUrl,
  GITHUB,
  GITHUB_EMAILS,
  GITHUB_USER,
  GOOGLE,
  isAllowed,
  type Identity,
  type SsoEndpoints,
  type SsoKind,
} from './providers';

const KEY = 'sso.providers';
const MAX_PROVIDERS = 10;
const STATE_MINUTES = 10;
const FINISH_SECONDS = 60;
export const SESSION_COOKIE = 'pvx_sso';
export const NONCE_COOKIE = 'pvx_sso_n';

interface StoredProvider {
  id: string;
  kind: SsoKind;
  label: string;
  clientId: string;
  /** Sealed with the server secret: never returned, never in a backup in the clear */
  secret: string;
  issuer?: string;
}

export interface SsoProviderView {
  id: string;
  kind: SsoKind;
  label: string;
  clientId: string;
  issuer: string | null;
}

export const ssoProviderInput = z
  .object({
    kind: z.enum(['google', 'github', 'oidc']),
    label: z.string().trim().min(1).max(60),
    clientId: z.string().trim().min(1).max(300),
    /** Left out (or empty) on an edit to keep the saved one */
    clientSecret: z.string().max(1000).optional(),
    issuer: z.string().trim().url().max(300).optional(),
  })
  .strict()
  .refine((p) => p.kind !== 'oidc' || !!p.issuer, {
    message: 'An OpenID Connect provider needs its issuer address.',
  });

/** What the proxy asks the API on every request to a protected app, and what the sign-in flow carries between pages */
interface State {
  app: string;
  provider: string;
  host: string;
  proto: 'http' | 'https';
  rd: string;
  verifier: string;
  nonce: string;
  exp: number;
}
interface Session {
  app: string;
  email: string;
  name: string;
  exp: number;
}
interface Finish extends Session {
  nonce: string;
  rd: string;
}

export type Fetcher = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

/** Only a path on the same site: never an address someone else could send a visitor to after they sign in */
export function safeReturnPath(rd: unknown): string {
  if (typeof rd !== 'string' || rd.length > 2000) return '/';
  if (!rd.startsWith('/') || rd.startsWith('//') || rd.includes('\\'))
    return '/';
  // The login and callback paths themselves would loop
  if (rd.startsWith('/.pvx-auth/')) return '/';
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/.test(rd) ? '/' : rd;
}

@Injectable()
export class SsoService {
  private readonly box: SecretBox;
  private discovered = new Map<string, SsoEndpoints>();
  /** Replaced in tests */
  fetcher: Fetcher = (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

  constructor(
    private readonly settings: SettingsService,
    private readonly repo: AppsRepo,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {
    this.box = new SecretBox(cfg.JWT_SECRET, 'sso');
  }

  // ---- what is available -------------------------------------------------------------------------------------

  /** Where providers send people back to: one address for every app, so it is registered once per provider */
  redirectUri(): string | null {
    return this.cfg.API_PUBLIC_URL
      ? `${this.cfg.API_PUBLIC_URL.replace(/\/+$/, '')}/internal/sso/callback`
      : null;
  }

  /** The sign-in needs the API reachable at its own address (for the callback) and the proxy able to ask it */
  available(): boolean {
    return !!this.redirectUri() && !!this.cfg.ERROR_PAGES_SERVICE;
  }

  verifyUrl(): string {
    return (
      this.cfg.SSO_VERIFY_URL ?? `http://pvx-provelox:${this.cfg.PORT}`
    ).replace(/\/+$/, '');
  }

  // ---- providers ---------------------------------------------------------------------------------------------

  private stored(): StoredProvider[] {
    return this.settings.get<StoredProvider[]>(KEY) ?? [];
  }

  private view(p: StoredProvider): SsoProviderView {
    return {
      id: p.id,
      kind: p.kind,
      label: p.label,
      clientId: p.clientId,
      issuer: p.issuer ?? null,
    };
  }

  list(): SsoProviderView[] {
    return this.stored().map((p) => this.view(p));
  }

  has(id: string): boolean {
    return this.stored().some((p) => p.id === id);
  }

  async save(id: string, body: unknown): Promise<SsoProviderView> {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
      throw new ValidationError('Use lowercase letters, numbers and dashes.');
    const parsed = ssoProviderInput.safeParse(body);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid input',
        parsed.error.issues,
      );
    const all = this.stored();
    const existing = all.find((p) => p.id === id);
    if (!existing && all.length >= MAX_PROVIDERS)
      throw new ConflictError(`At most ${MAX_PROVIDERS} sign-in providers.`);
    const secret = parsed.data.clientSecret
      ? this.box.seal(parsed.data.clientSecret)
      : existing?.secret;
    if (!secret)
      throw new ValidationError('The provider needs its client secret.');
    const next: StoredProvider = {
      id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      clientId: parsed.data.clientId,
      secret,
      ...(parsed.data.kind === 'oidc' ? { issuer: parsed.data.issuer } : {}),
    };
    // Fail now, with a clear message, rather than when the first visitor tries to sign in
    if (next.kind === 'oidc') {
      this.discovered.delete(id);
      await this.endpoints(next);
    }
    this.settings.set(KEY, [...all.filter((p) => p.id !== id), next]);
    return this.view(next);
  }

  /** Suggests an id for a new provider that nothing uses yet */
  freeId(label: string, kind: SsoKind): string {
    const base = slug(label) || kind;
    const taken = new Set(this.stored().map((p) => p.id));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const id = `${base.slice(0, 28)}-${i}`;
      if (!taken.has(id)) return id;
    }
  }

  remove(id: string) {
    const using = this.repo
      .list()
      .filter((a) => a.sso?.provider === id)
      .map((a) => a.name);
    if (using.length > 0)
      throw new ConflictError(
        `Apps still sign in with this provider: ${using.join(', ')}. Change them first.`,
      );
    const all = this.stored();
    if (!all.some((p) => p.id === id))
      throw new NotFoundError(`No sign-in provider "${id}".`);
    this.settings.set(
      KEY,
      all.filter((p) => p.id !== id),
    );
  }

  private provider(id: string): StoredProvider {
    const p = this.stored().find((x) => x.id === id);
    if (!p) throw new NotFoundError('That sign-in provider no longer exists.');
    return p;
  }

  private async endpoints(p: StoredProvider): Promise<SsoEndpoints> {
    if (p.kind === 'google') return GOOGLE;
    if (p.kind === 'github') return GITHUB;
    const known = this.discovered.get(p.id);
    if (known) return known;
    let doc: Record<string, unknown>;
    try {
      const res = await this.fetcher(discoveryUrl(p.issuer as string));
      if (!res.ok) throw new Error(`answered ${res.status}`);
      doc = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw new ValidationError(
        `Could not read ${discoveryUrl(p.issuer as string)}: ${e instanceof Error ? e.message : 'failed'}`,
      );
    }
    const str = (k: string) => (typeof doc[k] === 'string' ? doc[k] : '');
    const e: SsoEndpoints = {
      authorize: str('authorization_endpoint') as string,
      token: str('token_endpoint') as string,
      userinfo: str('userinfo_endpoint') as string,
      scope: 'openid email profile',
      pkce: true,
    };
    if (!e.authorize || !e.token || !e.userinfo)
      throw new ValidationError(
        'That issuer does not publish the endpoints a sign-in needs (authorization, token and userinfo).',
      );
    this.discovered.set(p.id, e);
    return e;
  }

  // ---- the sign-in -------------------------------------------------------------------------------------------

  /** An app's rules, or null when it has none (it is not protected) */
  private rulesOf(app: AppDefinition) {
    return app.sso ?? null;
  }

  /** Is this one of the app's own public addresses? The sign-in only ever sends people back to those. */
  ownsHost(app: AppDefinition, host: string): boolean {
    // The browser's address may carry a port (a proxy on a port other than 80 or 443): the app's addresses never do
    const bare = host.toLowerCase().replace(/:\d{1,5}$/, '');
    return hostsOf(app, this.settings.appsDomain()).some(
      (h) => h.host === bare,
    );
  }

  /** Where to send the visitor to sign in: the provider's page, with everything needed to finish carried in `state` */
  async start(
    app: AppDefinition,
    host: string,
    proto: 'http' | 'https',
    rd: unknown,
    now = Date.now(),
  ): Promise<{ url: string; nonce: string }> {
    const rules = this.rulesOf(app);
    const redirect = this.redirectUri();
    if (!rules || !redirect || !this.ownsHost(app, host))
      throw new NotFoundError('Not found');
    const p = this.provider(rules.provider);
    const e = await this.endpoints(p);
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const state: State = {
      app: app.name,
      provider: p.id,
      host: host.toLowerCase(),
      proto,
      rd: safeReturnPath(rd),
      verifier,
      nonce,
      exp: now + STATE_MINUTES * 60_000,
    };
    const q = new URLSearchParams({
      client_id: p.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: e.scope,
      state: this.box.seal(JSON.stringify(state)),
    });
    if (e.pkce) {
      q.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      q.set('code_challenge_method', 'S256');
    }
    // Ask which account every time: apps behind it may be used by people who hold several
    if (p.kind === 'google') q.set('prompt', 'select_account');
    return { url: `${e.authorize}?${q.toString()}`, nonce };
  }

  /**
   * The provider sent the visitor back with a code. Trades it for who they are, checks the app's rules, and returns
   * where to send them next: the app's own address, with a short-lived token that sets the cookie there.
   */
  async callback(
    code: string,
    sealedState: string,
    now = Date.now(),
  ): Promise<
    | { ok: true; url: string }
    | { ok: false; app: string; email: string; reason: 'denied' }
  > {
    const state = this.openState(sealedState, now);
    const app = this.repo.get(state.app);
    const rules = app ? this.rulesOf(app) : null;
    if (!app || !rules || rules.provider !== state.provider)
      throw new NotFoundError('Not found');
    const p = this.provider(state.provider);
    const who = await this.identify(p, code, state.verifier);
    if (!isAllowed(rules, who.email))
      return { ok: false, app: app.name, email: who.email, reason: 'denied' };
    const finish: Finish = {
      app: app.name,
      email: who.email,
      name: who.name,
      nonce: state.nonce,
      rd: state.rd,
      exp: now + FINISH_SECONDS * 1000,
    };
    const url = `${state.proto}://${state.host}/.pvx-auth/finish?t=${encodeURIComponent(this.box.seal(JSON.stringify(finish)))}`;
    return { ok: true, url };
  }

  private openState(sealed: string, now: number): State {
    const raw = this.box.open(sealed);
    let s: State | null = null;
    try {
      s = raw ? (JSON.parse(raw) as State) : null;
    } catch {
      s = null;
    }
    if (!s || typeof s.exp !== 'number' || s.exp < now)
      throw new ValidationError(
        'This sign-in took too long or was not started here. Open the app again and sign in.',
      );
    return s;
  }

  private async identify(
    p: StoredProvider,
    code: string,
    verifier: string,
  ): Promise<Identity> {
    const secret = this.box.open(p.secret);
    if (!secret)
      throw new ValidationError(
        'The saved client secret cannot be read: enter it again.',
      );
    const e = await this.endpoints(p);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri() as string,
      client_id: p.clientId,
      client_secret: secret,
    });
    if (e.pkce) body.set('code_verifier', verifier);
    let accessToken: string;
    try {
      const res = await this.fetcher(e.token, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      });
      const j = (await res.json()) as { access_token?: unknown };
      if (!res.ok || typeof j.access_token !== 'string')
        throw new Error('no token');
      accessToken = j.access_token;
    } catch {
      throw new ValidationError(
        'The provider did not accept the sign-in. Try again.',
      );
    }
    const get = async (url: string) => {
      const res = await this.fetcher(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          'user-agent': 'provelox',
        },
      });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return (await res.json()) as unknown;
    };
    try {
      if (p.kind === 'github') return await this.githubIdentity(get);
      const u = (await get(e.userinfo as string)) as Record<string, unknown>;
      const email = typeof u.email === 'string' ? u.email : '';
      // A provider that does not vouch for the address cannot be used to decide who gets in
      if (!email || u.email_verified === false)
        throw new Error('no verified email');
      const name = typeof u.name === 'string' && u.name ? u.name : email;
      return { email, name };
    } catch {
      throw new ValidationError(
        'The provider did not give a verified email address for this account.',
      );
    }
  }

  private async githubIdentity(
    get: (url: string) => Promise<unknown>,
  ): Promise<Identity> {
    const user = (await get(GITHUB_USER)) as { login?: string; name?: string };
    const emails = (await get(GITHUB_EMAILS)) as {
      email: string;
      primary: boolean;
      verified: boolean;
    }[];
    const primary = emails.find((m) => m.primary && m.verified);
    if (!primary) throw new Error('no verified primary email');
    return {
      email: primary.email,
      name: user.name || user.login || primary.email,
    };
  }

  // ---- the cookie --------------------------------------------------------------------------------------------

  /** Sets the cookie on the app's own address. The token must be fresh and the browser the one that started the sign-in. */
  finish(
    appName: string,
    token: string,
    nonceCookie: string | undefined,
    now = Date.now(),
  ): { cookie: string; maxAge: number; rd: string } {
    const raw = this.box.open(token);
    let f: Finish | null = null;
    try {
      f = raw ? (JSON.parse(raw) as Finish) : null;
    } catch {
      f = null;
    }
    if (
      !f ||
      f.app !== appName ||
      typeof f.exp !== 'number' ||
      f.exp < now ||
      !nonceCookie ||
      nonceCookie !== f.nonce
    )
      throw new ValidationError(
        'This sign-in could not be completed. Open the app again and sign in.',
      );
    const maxAge = this.cfg.SSO_SESSION_HOURS * 3600;
    const session: Session = {
      app: f.app,
      email: f.email,
      name: f.name,
      exp: now + maxAge * 1000,
    };
    return {
      cookie: this.box.seal(JSON.stringify(session)),
      maxAge,
      rd: safeReturnPath(f.rd),
    };
  }

  /** Is this cookie a current sign-in for the app, by someone its rules still let in? */
  check(
    app: AppDefinition,
    cookie: string | undefined,
    now = Date.now(),
  ): Identity | null {
    const rules = this.rulesOf(app);
    if (!rules || !cookie) return null;
    const raw = this.box.open(cookie);
    if (!raw) return null;
    let s: Session;
    try {
      s = JSON.parse(raw) as Session;
    } catch {
      return null;
    }
    if (s.app !== app.name || typeof s.exp !== 'number' || s.exp < now)
      return null;
    // Rules are read each time, so removing someone takes effect at once
    return isAllowed(rules, s.email) ? { email: s.email, name: s.name } : null;
  }
}
