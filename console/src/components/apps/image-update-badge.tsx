import { ArrowUpCircle } from 'lucide-react';
import {
  updateLabel,
  updateTitle,
  updateTone,
  type ImageUpdate,
} from '@/lib/image-updates';

/** A newer image for an app: the version, or "new build". Nothing at all when it is up to date. */
export function ImageUpdateBadge({
  update,
}: {
  update: ImageUpdate | undefined;
}) {
  const label = updateLabel(update);
  if (!update || !label) return null;
  return (
    <span
      title={updateTitle(update)}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${updateTone(update)}`}
    >
      <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
