import type { ImageUpdate } from '@/lib/image-updates';

/**
 * The image to deploy to take the update: the app's own image with its tag swapped for the newer one, or the same
 * image again when the registry rebuilt the tag it runs. Null when it cannot be done from here (no image, or one
 * pinned by digest, which names exactly one build).
 */
export function upgradeTarget(
  image: string | undefined,
  update: ImageUpdate | undefined,
): string | null {
  if (!image || !update || image.includes('@')) return null;
  if (update.latest) {
    const swapped = image.replace(/:[^:/]+$/, '');
    return `${swapped}:${update.latest.tag}`;
  }
  return update.rebuilt ? image : null;
}
