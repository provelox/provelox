/** The repository part of an image reference: no tag and no digest. `ghcr.io/acme/web:1.2` is `ghcr.io/acme/web`. */
export function imageRepository(image: string): string {
  return image.replace(/@sha256:[a-f0-9]+$/i, '').replace(/:[^/:]+$/, '');
}

// A registry (optionally with a port), then path segments: ghcr.io/acme/web, localhost:5000/app, nginx
const REPOSITORY_RE =
  /^[a-z0-9][a-z0-9._-]*(:[0-9]{1,5})?(\/[a-z0-9][a-z0-9._-]*)*$/i;

/** The repository a deploy key may be given, or null when what was typed is not a repository. */
export function parseImageRepository(raw: string): string | null {
  const repo = imageRepository(raw.trim());
  return repo.length > 0 && repo.length <= 255 && REPOSITORY_RE.test(repo)
    ? repo
    : null;
}
