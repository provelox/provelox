import { createHash, randomBytes } from 'node:crypto';
import { ValidationError } from '../common/errors';
import { LABEL_APP } from '../common/naming';
import { registryOf } from '../registries/registry-domain';
import type { DockerPort, RegistryAuth } from '../docker/docker.port';
import {
  SELF_ADMIN_SECRET,
  SELF_APP,
  SELF_JWT_SECRET,
  buildApiSpec,
} from './api-spec';
import {
  CONSOLE_APP,
  CONSOLE_SESSION_SECRET,
  buildConsoleSpec,
} from './console-spec';

export interface BootstrapOptions {
  image: string;
  port?: number;
  httpPort?: number;
  httpsPort?: number;
  rootDomain?: string;
  acmeEmail?: string;
  acmeStaging?: boolean;
  apiHost?: string;
  apiSsl?: boolean;
  traefikImage?: string;
  certResolver?: string;
  /**
   * Also install (or upgrade) the web console as a platform service. It is served at consoleHost, which defaults to
   * console.<rootDomain>.
   */
  consoleImage?: string;
  consoleHost?: string;
  consoleSsl?: boolean;
  /** First install only: otherwise the API generates one and prints it to its log */
  adminPassword?: string;
  /** Sign-in for the registry the image comes from, when it is private. Swarm keeps it to pull on every node. */
  registryAuth?: RegistryAuth;
}

export interface BootstrapResult {
  action: 'created' | 'updated';
  /** Set when the console was installed or upgraded in the same run */
  console?: 'created' | 'updated';
  /** True when the JWT secret already existed (an upgrade), false on a first install */
  existingInstall: boolean;
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/;

/** The address people (and CI) use to reach a host: the port only shows when it is not the standard one. */
export function publicUrl(
  host: string,
  ssl: boolean,
  httpPort: number,
  httpsPort: number,
) {
  const port = ssl ? httpsPort : httpPort;
  const standard = ssl ? 443 : 80;
  return `${ssl ? 'https' : 'http'}://${host}${port === standard ? '' : `:${port}`}`;
}

/**
 * Installs or upgrades the platform itself: puts the API (and, when asked, the console) on Swarm as managed
 * services. Safe to run again (that is how you upgrade). The API then starts the proxy by itself.
 */
export async function bootstrap(
  docker: DockerPort,
  o: BootstrapOptions,
): Promise<BootstrapResult> {
  if (!IMAGE.test(o.image))
    throw new ValidationError('Give the API image as registry/name:tag.');
  for (const [what, host] of [
    ['root domain', o.rootDomain],
    ['API host', o.apiHost],
  ] as const)
    if (host && !HOST.test(host))
      throw new ValidationError(`The ${what} "${host}" is not a valid domain.`);
  if (o.apiHost && o.apiSsl && !o.acmeEmail)
    throw new ValidationError(
      "HTTPS for the API needs a Let's Encrypt email (acmeEmail).",
    );

  const consoleHost =
    o.consoleHost ?? (o.rootDomain ? `console.${o.rootDomain}` : undefined);
  if (o.consoleImage) {
    if (!IMAGE.test(o.consoleImage))
      throw new ValidationError('Give the console image as registry/name:tag.');
    if (!consoleHost)
      throw new ValidationError(
        'Say where the console is served: --console-host, or a root domain to derive it from.',
      );
    if (!HOST.test(consoleHost))
      throw new ValidationError(
        `The console host "${consoleHost}" is not a valid domain.`,
      );
    if (o.consoleSsl && !o.acmeEmail)
      throw new ValidationError(
        "HTTPS for the console needs a Let's Encrypt email (acmeEmail).",
      );
  }

  await docker.ensureNetwork('provelox-net', {});
  const labels = { [LABEL_APP]: SELF_APP };

  // Secrets are immutable and ensureSecret keeps an existing one, so re-running never changes the signing key
  // (which would sign everyone out)
  const jwtValue = randomBytes(48).toString('base64url');
  const jwtBefore = await docker.ensureSecret(
    SELF_JWT_SECRET,
    jwtValue,
    labels,
  );
  const adminPassword = o.adminPassword
    ? await docker.ensureSecret(SELF_ADMIN_SECRET, o.adminPassword, labels)
    : undefined;

  // The sign-in lives in the services (Docker keeps it for pulls) but Docker never shows it back, so Provelox could
  // not know it had one. Hand it over as a secret too: on start the API adds it to Settings → Registries, which is
  // where the update from the hub looks, and where it can be changed later.
  const registrySeed = o.registryAuth
    ? await docker.ensureSecret(
        `pvx-registry-${createHash('sha256')
          .update(JSON.stringify([registryOf(o.image), o.registryAuth]))
          .digest('hex')
          .slice(0, 12)}`,
        JSON.stringify({
          domain: registryOf(o.image),
          username: o.registryAuth.username,
          password: o.registryAuth.password,
        }),
        labels,
      )
    : undefined;

  const httpPort = o.httpPort ?? 80;
  const httpsPort = o.httpsPort ?? 443;
  const spec = buildApiSpec({
    image: o.image,
    port: o.port ?? 4000,
    httpPort,
    httpsPort,
    certResolver: o.certResolver ?? 'le',
    traefikImage: o.traefikImage,
    rootDomain: o.rootDomain,
    acmeEmail: o.acmeEmail,
    acmeStaging: o.acmeStaging,
    apiHost: o.apiHost ? { host: o.apiHost, ssl: !!o.apiSsl } : undefined,
    jwtSecret: jwtBefore,
    adminPassword,
    registrySeed,
  });
  // Roll the services even when the image reference is unchanged, so a moving tag (latest) really upgrades
  const action = await docker.applyService(spec, SELF_APP, o.registryAuth, {
    forceRollout: true,
  });

  let consoleAction: BootstrapResult['console'];
  if (o.consoleImage && consoleHost) {
    // Like the API's signing key: created once and kept, so upgrading the console never signs anyone out
    const session = await docker.ensureSecret(
      CONSOLE_SESSION_SECRET,
      randomBytes(48).toString('base64url'),
      { [LABEL_APP]: CONSOLE_APP },
    );
    consoleAction = await docker.applyService(
      buildConsoleSpec({
        image: o.consoleImage,
        host: { host: consoleHost, ssl: !!o.consoleSsl },
        certResolver: o.certResolver ?? 'le',
        apiUrl: `http://${SELF_APP}:${o.port ?? 4000}`,
        publicApiUrl: o.apiHost
          ? publicUrl(o.apiHost, !!o.apiSsl, httpPort, httpsPort)
          : undefined,
        sessionSecret: session,
      }),
      CONSOLE_APP,
      o.registryAuth,
      { forceRollout: true },
    );
  }
  return {
    action,
    console: consoleAction,
    existingInstall: action === 'updated',
  };
}
