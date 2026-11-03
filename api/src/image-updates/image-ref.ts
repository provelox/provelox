import { registryOf } from '../registries/registry-domain';

export interface ImageRef {
  /** Normalised registry name: docker.io, ghcr.io, localhost:5001 */
  registry: string;
  /** The repository on that registry. Docker Hub's official images are under library/ */
  repo: string;
  tag: string | null;
  /** The sha256:… the reference pins, when it does */
  digest: string | null;
}

/** Splits an image reference the way Docker does. Null for something that cannot be one. */
export function parseImageRef(image: string): ImageRef | null {
  let rest = image.trim();
  if (!rest || /\s/.test(rest)) return null;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  }
  const registry = registryOf(rest);
  // Whether the reference starts with a registry name, as Docker decides it: a dot, a port or localhost in the first part
  const first = rest.split('/')[0];
  const hasHost =
    rest.includes('/') &&
    (first.includes('.') || first.includes(':') || first === 'localhost');
  let path = hasHost ? rest.slice(first.length + 1) : rest;
  let tag: string | null = null;
  const slash = path.lastIndexOf('/');
  const colon = path.indexOf(':', slash + 1);
  if (colon !== -1) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
  }
  if (
    !path ||
    !/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(path)
  )
    return null;
  if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag))
    return null;
  const repo =
    registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path;
  return { registry, repo, tag: tag ?? (digest ? null : 'latest'), digest };
}

/** What a person would write: the reference without its registry's home name or `library/`. */
export function displayRef(ref: ImageRef): string {
  const repo =
    ref.registry === 'docker.io'
      ? ref.repo.replace(/^library\//, '')
      : `${ref.registry}/${ref.repo}`;
  return ref.tag ? `${repo}:${ref.tag}` : repo;
}

/** The address the registry's API answers on (Docker Hub's differs from its name). */
export function apiHost(registry: string): string {
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}
