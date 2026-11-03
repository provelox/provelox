import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, ValidationError } from '../common/errors';
import {
  DOCKER,
  type DockerPort,
  type RegistryAuth,
} from '../docker/docker.port';
import { RegistriesService } from '../registries/registries.service';
import { registryOf } from '../registries/registry-domain';
import { SELF_APP, SELF_SERVICE } from './api-spec';
import { CONSOLE_APP, CONSOLE_SERVICE } from './console-spec';

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,20})?$/;

/** The same image on another tag: registry/name:0.2.6 -> registry/name:0.2.7. A registry port is not a tag. */
/**
 * Orders pre-release tags the way semver does: split on dots, compare each part (numbers as numbers, so rc.10 comes
 * after rc.8), a number before a word, and the shorter list first when everything else is equal.
 */
function comparePre(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) return Number(x[i]) - Number(y[i]);
    if (nx) return -1;
    if (ny) return 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

/** Orders release numbers: 0.2.10 after 0.2.9, and 1.0.0-rc.1 before 1.0.0. Negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split(/-(.+)/);
    return { n: core.split('.').map(Number), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePre(x.pre, y.pre);
}

export function retag(image: string, version: string): string {
  const noDigest = image.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  const repo = colon > slash ? noDigest.slice(0, colon) : noDigest;
  return `${repo}:${version}`;
}

/**
 * Why an update was refused before it began, saying whether a sign-in was tried: with none the fix is to add one, with
 * one the registry turned it down, which is a different problem (a token that logs in but cannot read this package).
 */
export function refusal(
  image: string,
  reason: string,
  auth?: RegistryAuth,
): string {
  const registry = registryOf(image);
  if (!auth)
    return `This server cannot pull ${image} (no sign-in is stored for ${registry}): ${reason}. If the image is private, add the registry's sign-in under Settings → Registries (for GitHub: ghcr.io, with a token that can read packages), or make the image public.`;
  return `This server cannot pull ${image}, even with the stored sign-in for ${registry} (user ${auth.username}): ${reason}. The registry accepted that account but not for this image: check that the token can read packages and belongs to an account that can see it, edit it under Settings → Registries, or make the image public.`;
}

export interface UpdateResult {
  from: string;
  to: string;
  image: string;
}

/**
 * Upgrades the platform itself from inside: the API and the console move to another tag of the image they run
 * from. Nothing else is rebuilt, so every setting, secret and the data volume stay as they are, and apps are not
 * touched. The API goes last because its own restart ends this process; the console follows the API's image so the
 * two never drift apart.
 */
@Injectable()
export class SelfUpdateService {
  constructor(
    @Inject(DOCKER) private readonly docker: DockerPort,
    private readonly registries: RegistriesService,
  ) {}

  async update(rawVersion: string): Promise<UpdateResult> {
    const version = rawVersion.trim().replace(/^v/, '');
    if (!VERSION.test(version))
      throw new ValidationError(
        'Give a release number such as 0.2.7. Moving tags like latest are not accepted here.',
      );
    const api = await this.docker.serviceStatus(SELF_SERVICE);
    if (!api?.image)
      throw new ValidationError(
        'The API is not running as a Swarm service, so it cannot be updated from here. Re-run the install command instead.',
      );
    if (
      api.updateState === 'updating' ||
      api.updateState === 'rollback_started'
    )
      throw new ConflictError(
        'An update is already in progress. Wait for it to finish.',
      );
    const image = retag(api.image, version);
    if (image === api.image)
      throw new ConflictError(`Already running ${version}.`);
    // An older release may hold a flaw that a newer one fixed: going back is a reinstall, not an update
    const running = api.image.match(
      /:(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:@|$)/,
    )?.[1];
    if (running && compareVersions(version, running) < 0)
      throw new ConflictError(
        `${version} is older than the ${running} that is running. Updating only goes forward; to go back, reinstall that release.`,
      );

    // Ask the registry before changing anything: a private image the server cannot pull would otherwise start an
    // update that fails and is rolled back, minutes later and with no reason given. The sign-in is the one stored
    // under Settings → Registries for the image's registry, if there is one.
    const auth = this.registries.authFor(image);
    const pull = await this.docker.canPull(image, auth);
    if (!pull.ok) throw new ConflictError(refusal(image, pull.reason, auth));

    // The console first: it only restarts a web page. Its absence is fine (an API-only install).
    await this.docker.editService(
      CONSOLE_SERVICE,
      CONSOLE_APP,
      (s) => {
        s.TaskTemplate.ContainerSpec.Image = retag(
          s.TaskTemplate.ContainerSpec.Image,
          version,
        );
        return s;
      },
      { auth },
    );
    await this.docker.editService(
      SELF_SERVICE,
      SELF_APP,
      (s) => {
        s.TaskTemplate.ContainerSpec.Image = image;
        return s;
      },
      { auth },
    );
    return { from: api.image, to: image, image };
  }
}
