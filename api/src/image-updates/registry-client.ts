import { unsafeTarget } from '../common/url-safety';
import { apiHost, type ImageRef } from './image-ref';

export interface RegistryCreds {
  username: string;
  password: string;
}

export type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;
const MAX_BODY = 4 * 1024 * 1024;
/** gcr.io lists every manifest beside the tags, so a big repository's list is big */
const MAX_TAGS_BODY = 32 * 1024 * 1024;
const MAX_PAGES = 10;
const TOKEN_KEEP_MS = 4 * 60_000;

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export class RegistryError extends Error {}

/** example.com out of a.b.example.com. Good enough to tell a registry's own token service from someone else's. */
const registrable = (host: string) => host.split('.').slice(-2).join('.');

const isLocal = (host: string) =>
  host === 'localhost' ||
  host.startsWith('127.') ||
  host === '[::1]' ||
  host.endsWith('.local');

/**
 * Where a registry may send us for a token. It is the registry that names the address, so it is only followed when it
 * is the same site (auth.docker.io for registry-1.docker.io, ghcr.io for ghcr.io), over https, and never somewhere
 * the server must not be sent (the cloud metadata address, link-local ranges).
 */
export function realmAllowed(realm: string, registryHost: string): boolean {
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLocal(url.hostname))
  )
    return false;
  if (unsafeTarget(url)) return false;
  const a = url.hostname.toLowerCase();
  const b = registryHost.toLowerCase().replace(/:\d+$/, '');
  return (
    a === b ||
    (!/^[\d.]+$/.test(a) && !isLocal(a) && registrable(a) === registrable(b))
  );
}

function parseChallenge(header: string | null) {
  if (!header) return null;
  const scheme = header.split(' ')[0].toLowerCase();
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g))
    params[m[1].toLowerCase()] = m[2];
  return { scheme, params };
}

/**
 * Reads what a registry says about an image: its tags, and the digest a tag points at. It follows the registry's own
 * token handshake (anonymous, or with the sign-in the server already holds), asks for nothing but metadata and keeps
 * every answer small. Nothing here pulls an image.
 */
export class RegistryClient {
  private tokens = new Map<string, { value: string; until: number }>();

  constructor(
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async get(
    ref: ImageRef,
    path: string,
    creds: RegistryCreds | undefined,
    init: { method?: string; accept?: string } = {},
  ): Promise<Response> {
    const host = apiHost(ref.registry);
    // Local registries are often plain http; try https first and fall back only for those
    const schemes = isLocal(host.replace(/:\d+$/, ''))
      ? ['https', 'http']
      : ['https'];
    let last: unknown;
    for (const scheme of schemes) {
      try {
        return await this.request(
          `${scheme}://${host}`,
          ref,
          path,
          creds,
          init,
        );
      } catch (e) {
        last = e;
        if (e instanceof RegistryError) throw e;
      }
    }
    throw new RegistryError(
      `Could not reach ${ref.registry}${last instanceof Error ? `: ${last.message}` : ''}`,
    );
  }

  private async request(
    base: string,
    ref: ImageRef,
    path: string,
    creds: RegistryCreds | undefined,
    init: { method?: string; accept?: string },
  ): Promise<Response> {
    const key = `${ref.registry}|${ref.repo}`;
    const send = (auth?: string) =>
      this.fetcher(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.accept ? { Accept: init.accept } : {}),
          ...(auth ? { Authorization: auth } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      });
    const held = this.tokens.get(key);
    let res = await send(
      held && held.until > this.now() ? `Bearer ${held.value}` : undefined,
    );
    if (res.status !== 401) return res;
    const challenge = parseChallenge(res.headers.get('www-authenticate'));
    if (!challenge) return res;
    if (challenge.scheme === 'basic' && creds)
      return send(
        `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
      );
    if (challenge.scheme !== 'bearer' || !challenge.params.realm) return res;
    if (!realmAllowed(challenge.params.realm, new URL(base).host))
      throw new RegistryError(
        'The registry asked for a sign-in at an address it does not own, so it was not followed.',
      );
    const url = new URL(challenge.params.realm);
    if (challenge.params.service)
      url.searchParams.set('service', challenge.params.service);
    url.searchParams.set(
      'scope',
      challenge.params.scope ?? `repository:${ref.repo}:pull`,
    );
    const tokenRes = await this.fetcher(url, {
      headers: creds
        ? {
            Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
          }
        : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!tokenRes.ok)
      throw new RegistryError(
        tokenRes.status === 401 || tokenRes.status === 403
          ? creds
            ? `${ref.registry} did not accept the saved sign-in for ${ref.repo}`
            : `${ref.registry} needs a sign-in to read ${ref.repo}. Add one under Registries.`
          : `${ref.registry} refused a token (${tokenRes.status})`,
      );
    const body = JSON.parse(await this.text(tokenRes)) as {
      token?: string;
      access_token?: string;
    };
    const token = body.token ?? body.access_token;
    if (!token) throw new RegistryError(`${ref.registry} sent no token`);
    this.tokens.set(key, { value: token, until: this.now() + TOKEN_KEEP_MS });
    return send(`Bearer ${token}`);
  }

  private async text(res: Response, max = MAX_BODY): Promise<string> {
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > max) throw new RegistryError('The registry sent too much.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max)
      throw new RegistryError('The registry sent too much.');
    return buf.toString('utf8');
  }

  private fail(ref: ImageRef, res: Response): never {
    throw new RegistryError(
      res.status === 404
        ? `${ref.registry} has no ${ref.repo}`
        : res.status === 401 || res.status === 403
          ? `${ref.registry} does not let this server read ${ref.repo}. Add its sign-in under Registries.`
          : `${ref.registry} answered ${res.status}`,
    );
  }

  /** Every tag of the repository, following the registry's own paging. */
  async tags(ref: ImageRef, creds?: RegistryCreds): Promise<string[]> {
    const out: string[] = [];
    let path: string | null = `/v2/${ref.repo}/tags/list?n=1000`;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const res = await this.get(ref, path, creds);
      if (!res.ok) this.fail(ref, res);
      const body = JSON.parse(await this.text(res, MAX_TAGS_BODY)) as {
        tags?: unknown;
      };
      if (Array.isArray(body.tags))
        for (const t of body.tags) if (typeof t === 'string') out.push(t);
      // `Link: </v2/x/tags/list?last=…&n=1000>; rel="next"`: only a path on the same registry is followed
      const next = res.headers
        .get('link')
        ?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      path = next && next.startsWith('/v2/') ? next : null;
    }
    return out;
  }

  /** The digest the registry gives the tag now, from a header: no image data is downloaded. */
  async digest(
    ref: ImageRef,
    tag: string,
    creds?: RegistryCreds,
  ): Promise<string | null> {
    const res = await this.get(ref, `/v2/${ref.repo}/manifests/${tag}`, creds, {
      method: 'HEAD',
      accept: MANIFEST_ACCEPT,
    });
    if (res.status === 404) return null;
    if (!res.ok) this.fail(ref, res);
    const d = res.headers.get('docker-content-digest');
    return d && /^sha256:[0-9a-f]{64}$/.test(d) ? d : null;
  }
}
