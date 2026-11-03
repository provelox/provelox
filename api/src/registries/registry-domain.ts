/** The registry host an image reference points at. Docker Hub when none is given ("nginx", "acme/app"). */
export function registryOf(image: string): string {
  const first = image.split('/')[0];
  const hasHost =
    image.includes('/') &&
    (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!hasHost) return 'docker.io';
  return first === 'index.docker.io' || first === 'registry-1.docker.io'
    ? 'docker.io'
    : first.toLowerCase();
}

/** Registry domains compare equal when they are the same host (Docker Hub has several names). */
export function normalizeRegistryDomain(domain: string): string {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return d === 'index.docker.io' ||
    d === 'registry-1.docker.io' ||
    d === 'hub.docker.com'
    ? 'docker.io'
    : d;
}
