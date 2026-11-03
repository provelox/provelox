import type { AppDefinition } from '../apps/app.model';
import { SHARED_NETWORK } from '../common/naming';

export interface RoutingContext {
  /** Apps are served at <name>.<rootDomain>. Null until a root domain is configured */
  rootDomain: string | null;
  /** Traefik certificate resolver (Let's Encrypt) */
  certResolver: string;
  /** Traefik service that serves GET /internal/error-pages/<app>/<status>. Null: custom error pages are not served */
  errorPagesService: string | null;
  /** Saved address ranges by CDN id. An app set to enforce its CDN answers only from them. */
  cdnRanges?: Record<string, string[]>;
  /**
   * What sign-in with an identity provider needs: where the proxy asks the API whether a visitor is signed in, and the
   * Traefik service that reaches the API (for the pages under /.pvx-auth/ on the app's own address). Unset: not
   * available, and an app that asks for it is not served at all rather than served open.
   */
  sso?: { verifyUrl: string; service: string };
}

/** The pages of the sign-in flow, served by the API at every protected app's own address */
export const SSO_PATH = '/.pvx-auth/';

export interface Host {
  host: string;
  ssl: boolean;
}

/** Every public hostname of an app, default subdomain first. Empty for apps that are not exposed. */
export function hostsOf(app: AppDefinition, rootDomain: string | null): Host[] {
  if (!app.exposed) return [];
  const hosts: Host[] = [];
  if (rootDomain && app.defaultSubdomain)
    hosts.push({
      host: `${app.name}.${rootDomain}`,
      ssl: app.defaultSubdomainSsl,
    });
  for (const d of app.domains)
    if (!hosts.some((h) => h.host === d.host))
      hosts.push({ host: d.host, ssl: d.ssl });
  return hosts;
}

const rule = (hosts: Host[]) =>
  hosts.map((h) => `Host(\`${h.host}\`)`).join(' || ');

/**
 * Traefik reads these from the Swarm service's labels. Plain-HTTP hosts are served on `web`; HTTPS hosts get a
 * certificate on `websecure`, and their `web` router either redirects to HTTPS (force SSL) or serves plainly.
 */
export function routingLabels(
  app: AppDefinition,
  ctx: RoutingContext,
): Record<string, string> {
  const hosts = hostsOf(app, ctx.rootDomain);
  if (hosts.length === 0) return { 'traefik.enable': 'false' };
  // Never serve a protected app open because the means to protect it are missing
  if (app.sso && !ctx.sso) return { 'traefik.enable': 'false' };

  const id = app.name;
  // With a primary address only it serves the app; every other address answers with a redirect to it
  const primary = hosts.find((h) => h.host === app.primaryDomain);
  const moved = primary ? hosts.filter((h) => h !== primary) : [];
  const served = primary ? [primary] : hosts;
  const ssl = served.filter((h) => h.ssl);
  const plain = served.filter((h) => !h.ssl);
  const webPlain = app.forceSsl ? plain : served;
  const redirect = app.forceSsl ? ssl : [];

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    // Traefik must reach the container on the network it shares with the proxy. Only the Swarm label: Traefik
    // skips a service that carries both Swarm and Docker labels.
    'traefik.swarm.network': SHARED_NETWORK,
    [`traefik.http.services.${id}.loadbalancer.server.port`]: String(
      app.containerPort,
    ),
  };
  // Every app gets the error pages: its own where it set one, Provelox's branded default for the rest
  const errorsMiddleware = ctx.errorPagesService ? `${id}-errors` : null;
  if (errorsMiddleware) {
    const m = `traefik.http.middlewares.${errorsMiddleware}.errors`;
    labels[`${m}.status`] = '502-504';
    labels[`${m}.service`] = ctx.errorPagesService as string;
    labels[`${m}.query`] = `/internal/error-pages/${app.name}/{status}`;
  }
  // HTTP basic auth: the proxy asks for a password before the request reaches the app. Authorization is not passed on.
  const authMiddleware = app.basicAuth?.users.length ? `${id}-auth` : null;
  if (authMiddleware && app.basicAuth) {
    const m = `traefik.http.middlewares.${authMiddleware}.basicauth`;
    labels[`${m}.users`] = app.basicAuth.users
      .map((u) => `${u.name}:${u.hash}`)
      .join(',');
    labels[`${m}.removeheader`] = 'true';
    labels[`${m}.realm`] = id;
  }
  // Sign in with an identity provider: the proxy asks the API about every request. The API answers with who the visitor
  // is, and the app gets that in two headers (any the visitor sent are dropped, so they cannot be forged).
  const ssoMiddleware = app.sso && ctx.sso ? `${id}-sso` : null;
  if (ssoMiddleware && ctx.sso) {
    const m = `traefik.http.middlewares.${ssoMiddleware}.forwardauth`;
    labels[`${m}.address`] = `${ctx.sso.verifyUrl}/internal/sso/verify/${id}`;
    labels[`${m}.authresponseheaders`] = 'X-Provelox-User,X-Provelox-Email';
    labels[`traefik.http.middlewares.${id}-sso-path.replacepathregex.regex`] =
      '^/\\.pvx-auth/(.*)';
    labels[
      `traefik.http.middlewares.${id}-sso-path.replacepathregex.replacement`
    ] = `/internal/sso/app/${id}/\${1}`;
  }
  // Only the CDN may reach the app: a request from any other address is refused before anything else runs
  const cdnRanges = app.cdn?.enforce
    ? ctx.cdnRanges?.[app.cdn.provider]
    : undefined;
  const cdnMiddleware = cdnRanges?.length ? `${id}-cdn` : null;
  if (cdnMiddleware && cdnRanges)
    labels[
      `traefik.http.middlewares.${cdnMiddleware}.ipallowlist.sourcerange`
    ] = cdnRanges.join(',');
  const router = (
    suffix: string,
    hostList: Host[],
    entry: string,
    protect = true,
  ) => {
    const key = `traefik.http.routers.${id}-${suffix}`;
    labels[`${key}.rule`] = rule(hostList);
    labels[`${key}.entrypoints`] = entry;
    labels[`${key}.service`] = id;
    const chain = [
      cdnMiddleware,
      protect ? ssoMiddleware : null,
      protect ? authMiddleware : null,
      errorsMiddleware,
    ].filter(Boolean);
    if (chain.length > 0) labels[`${key}.middlewares`] = chain.join(',');
    return key;
  };
  // Paths that stay open without a password (a webhook, a health check): a router for them at a higher priority than
  // the protected ones, on the same hosts, without the password middleware
  // With both a password and a sign-in, only what neither asks for stays open
  const openLists = [
    authMiddleware ? (app.basicAuth?.openPaths ?? []) : null,
    ssoMiddleware ? (app.sso?.openPaths ?? []) : null,
  ].filter((l): l is string[] => l !== null);
  const openPaths = openLists.reduce<string[]>(
    (a, l) => a.filter((p) => l.includes(p)),
    openLists[0] ?? [],
  );
  // The sign-in pages themselves: reached without being signed in, answered by the API
  const ssoRouter = (suffix: string, hostList: Host[], entry: string) => {
    const key = `traefik.http.routers.${id}-${suffix}`;
    labels[`${key}.rule`] =
      `(${rule(hostList)}) && PathPrefix(\`${SSO_PATH}\`)`;
    labels[`${key}.priority`] = '200000';
    labels[`${key}.entrypoints`] = entry;
    labels[`${key}.service`] = (ctx.sso as { service: string }).service;
    labels[`${key}.middlewares`] = [cdnMiddleware, `${id}-sso-path`]
      .filter(Boolean)
      .join(',');
    return key;
  };
  const openRouter = (suffix: string, hostList: Host[], entry: string) => {
    const key = `traefik.http.routers.${id}-${suffix}`;
    const paths = openPaths.map((p) => `PathPrefix(\`${p}\`)`).join(' || ');
    labels[`${key}.rule`] = `(${rule(hostList)}) && (${paths})`;
    labels[`${key}.priority`] = '100000';
    labels[`${key}.entrypoints`] = entry;
    labels[`${key}.service`] = id;
    const chain = [cdnMiddleware, errorsMiddleware].filter(Boolean);
    if (chain.length > 0) labels[`${key}.middlewares`] = chain.join(',');
    return key;
  };

  if (webPlain.length > 0) {
    router('web', webPlain, 'web');
    if (openPaths.length > 0) openRouter('open-web', webPlain, 'web');
    if (ssoMiddleware) ssoRouter('sso-web', webPlain, 'web');
  }
  if (redirect.length > 0) {
    const key = router('redirect', redirect, 'web');
    labels[`traefik.http.middlewares.${id}-https.redirectscheme.scheme`] =
      'https';
    labels[`traefik.http.middlewares.${id}-https.redirectscheme.permanent`] =
      'true';
    labels[`${key}.middlewares`] = [cdnMiddleware, `${id}-https`]
      .filter(Boolean)
      .join(',');
  }
  if (ssl.length > 0) {
    const key = router('websecure', ssl, 'websecure');
    labels[`${key}.tls`] = 'true';
    labels[`${key}.tls.certresolver`] = ctx.certResolver;
    if (openPaths.length > 0) {
      const open = openRouter('open-websecure', ssl, 'websecure');
      labels[`${open}.tls`] = 'true';
      labels[`${open}.tls.certresolver`] = ctx.certResolver;
    }
    if (ssoMiddleware) {
      const pages = ssoRouter('sso-websecure', ssl, 'websecure');
      labels[`${pages}.tls`] = 'true';
      labels[`${pages}.tls.certresolver`] = ctx.certResolver;
    }
  }
  if (primary && moved.length > 0) {
    // One hop to the final address, keeping the path and query. The secure router exists so a certificate is
    // issued for the old address too, otherwise https://old-address would fail before it could redirect.
    const mw = `traefik.http.middlewares.${id}-primary.redirectregex`;
    labels[`${mw}.regex`] = '^https?://[^/]+/?(.*)';
    labels[`${mw}.replacement`] =
      `${primary.ssl ? 'https' : 'http'}://${primary.host}/\${1}`;
    labels[`${mw}.permanent`] = 'true';
    const moveRouter = (suffix: string, list: Host[], entry: string) => {
      const key = `traefik.http.routers.${id}-${suffix}`;
      labels[`${key}.rule`] = rule(list);
      labels[`${key}.entrypoints`] = entry;
      labels[`${key}.service`] = id;
      labels[`${key}.middlewares`] = [cdnMiddleware, `${id}-primary`]
        .filter(Boolean)
        .join(',');
      return key;
    };
    moveRouter('moved', moved, 'web');
    const movedSsl = moved.filter((h) => h.ssl);
    if (movedSsl.length > 0) {
      const key = moveRouter('moved-secure', movedSsl, 'websecure');
      labels[`${key}.tls`] = 'true';
      labels[`${key}.tls.certresolver`] = ctx.certResolver;
    }
  }
  return labels;
}
