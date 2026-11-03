import { randomBytes } from 'node:crypto';
import { ValidationError } from '../common/errors';
import type { DockerPort, RegistryAuth } from '../docker/docker.port';
import { registryOf } from '../registries/registry-domain';
import {
  bootstrap,
  publicUrl,
  type BootstrapOptions,
  type BootstrapResult,
} from './bootstrap';
import { SELF_DATA_VOLUME, SELF_SERVICE } from './api-spec';

export interface InstallOptions {
  /** Apps are served at <app>.<rootDomain>. Required: there is no sensible default. */
  rootDomain: string;
  /** With an email, the API and console get HTTPS through Let's Encrypt. Without, they are plain HTTP. */
  acmeEmail?: string;
  acmeStaging?: boolean;
  apiHost?: string;
  consoleHost?: string;
  httpPort?: number;
  httpsPort?: number;
  traefikImage?: string;
  /** Needed when the machine has several addresses and Docker cannot choose one for a new Swarm */
  advertiseAddr?: string;
  /** Overrides the image this command runs from */
  image?: string;
  /** The first admin password. Generated when missing. Ignored on an upgrade. */
  adminPassword?: string;
  /**
   * For an image in a private registry: who to sign in as. Swarm pulls the platform's own services with it, on every
   * node, so it is needed on every install and upgrade.
   */
  registryUser?: string;
  registryPassword?: string;
}

export interface InstallResult extends BootstrapResult {
  image: string;
  swarmCreated: boolean;
  apiUrl: string;
  consoleUrl: string;
  /** Only on a first install without a given password: shown once, never stored in clear anywhere else */
  generatedPassword?: string;
  /**
   * The host already had Provelox's database (an earlier install whose services are gone, such as after leaving the
   * Swarm). It is kept as it is: its admin password and apps apply, and no new password is made.
   */
  existingData: boolean;
  /** True when HTTPS is off, so tokens and passwords travel unencrypted */
  insecure: boolean;
}

const IMAGE_ID = /^(sha256:)?[0-9a-f]{12,64}$/;

/**
 * One command to set Provelox up, or upgrade it, from its own image:
 *   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock <image> install --root-domain example.com
 * Creates a Swarm when the host has none, then installs the API, the proxy and the console from this same image.
 */
/**
 * Docker takes a moment to finish removing an overlay network after `uninstall`: a service that is created in that
 * moment fails with "network ... not found". Starting the install again a few seconds later works, so do that.
 */
export async function withNetworkLag<T>(
  run: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
  tries = 6,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      const lag = /network .*not found/i.test(
        e instanceof Error ? e.message : String(e),
      );
      if (!lag || i >= tries) throw e;
      await wait(5000);
    }
  }
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(() => r(), ms));

export async function install(
  docker: DockerPort,
  o: InstallOptions,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<InstallResult> {
  if (!o.rootDomain)
    throw new ValidationError(
      '--root-domain is required: apps are served at <app>.<root-domain>.',
    );

  const image = o.image ?? (await docker.selfImage());
  if (!image)
    throw new ValidationError(
      'Could not tell which image this is running from. Pass --image <image>, or run it with `docker run`.',
    );
  if (IMAGE_ID.test(image))
    throw new ValidationError(
      `This container was started from an image id (${image}), which the platform's services cannot be updated from. Start it by name and tag, or pass --image <name:tag>.`,
    );

  const registryAuth = await registryAuthFor(docker, image, o);

  let swarmCreated = false;
  const state = await docker.swarmState();
  if (state === 'worker')
    throw new ValidationError(
      'This host is a Swarm worker. Run the install on a manager node.',
    );
  if (state === 'none') {
    try {
      await docker.swarmInit(o.advertiseAddr);
    } catch (e) {
      throw new ValidationError(
        `Could not start a Swarm: ${e instanceof Error ? e.message : e}. If this machine has several network addresses, pass --advertise-addr <ip>.`,
      );
    }
    swarmCreated = true;
  }

  const running = (await docker.serviceStatus(SELF_SERVICE)) !== null;
  const existingData =
    !running && (await docker.volumeExists(SELF_DATA_VOLUME));
  // Only a host with neither a running platform nor its database gets a new admin password: otherwise it would
  // be printed but never used
  const first = !running && !existingData;
  const adminPassword = first
    ? (o.adminPassword ?? randomBytes(18).toString('base64url'))
    : undefined;

  const ssl = !!o.acmeEmail;
  const apiHost = o.apiHost ?? `api.${o.rootDomain}`;
  const consoleHost = o.consoleHost ?? `console.${o.rootDomain}`;
  const opts: BootstrapOptions = {
    image,
    consoleImage: image,
    rootDomain: o.rootDomain,
    apiHost,
    apiSsl: ssl,
    consoleHost,
    consoleSsl: ssl,
    acmeEmail: o.acmeEmail,
    acmeStaging: o.acmeStaging,
    httpPort: o.httpPort,
    httpsPort: o.httpsPort,
    traefikImage: o.traefikImage,
    adminPassword,
    registryAuth,
  };
  const r = await withNetworkLag(() => bootstrap(docker, opts), wait);

  const http = o.httpPort ?? 80;
  const https = o.httpsPort ?? 443;
  return {
    ...r,
    image,
    swarmCreated,
    apiUrl: publicUrl(apiHost, ssl, http, https),
    consoleUrl: publicUrl(consoleHost, ssl, http, https),
    generatedPassword: first && !o.adminPassword ? adminPassword : undefined,
    existingData,
    insecure: !ssl,
  };
}

/** The registry sign-in for the platform's image, checked before anything is changed. Undefined for a public image. */
async function registryAuthFor(
  docker: DockerPort,
  image: string,
  o: InstallOptions,
): Promise<RegistryAuth | undefined> {
  if (!o.registryUser && !o.registryPassword) return undefined;
  if (!o.registryUser || !o.registryPassword)
    throw new ValidationError(
      'A private registry needs both --registry-user and the password in PVX_REGISTRY_PASSWORD.',
    );
  const domain = registryOf(image);
  const auth: RegistryAuth = {
    username: o.registryUser,
    password: o.registryPassword,
    // Docker Hub's API address differs from its name
    serveraddress:
      domain === 'docker.io' ? 'https://index.docker.io/v1/' : domain,
  };
  try {
    await docker.checkRegistryAuth(auth);
  } catch {
    throw new ValidationError(
      `${domain} rejected that sign-in. Check the user and the token (for GitHub: a token that can read packages).`,
    );
  }
  return auth;
}
