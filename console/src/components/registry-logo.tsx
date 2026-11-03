import { BRAND_MARKS } from '@/lib/brand-marks';
import { providerOf, type RegistryPreset } from '@/lib/registries';
import { cn } from '@/lib/utils';

/** A provider's logo in a small coloured tile: its brand mark, or its name in its colour where no mark is available. */
export function RegistryLogo({
  preset,
  domain,
  className,
}: {
  preset?: RegistryPreset;
  /** Find the provider from an address when no preset is given */
  domain?: string;
  className?: string;
}) {
  const p = preset ?? providerOf(domain ?? '');
  const mark = p.mark;
  const brand = mark.kind === 'brand' ? BRAND_MARKS[mark.slug] : undefined;
  const bg = mark.kind === 'text' ? mark.bg : `#${brand?.hex ?? '666666'}`;
  return (
    <span
      role="img"
      aria-label={p.label}
      title={p.label}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-white shadow-xs',
        className,
      )}
      style={{ backgroundColor: bg }}
    >
      {brand ? (
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5 fill-current"
          aria-hidden="true"
        >
          <path d={brand.path} />
        </svg>
      ) : mark.kind === 'text' ? (
        <span className="text-[10px] font-bold leading-none tracking-tight">
          {mark.text}
        </span>
      ) : null}
    </span>
  );
}
