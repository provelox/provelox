'use client';

import { useState } from 'react';
import { BRAND_MARKS } from '@/lib/brand-marks';
import { cn } from '@/lib/utils';

const FALLBACKS = [
  '#4F46E5',
  '#0E7490',
  '#047857',
  '#B45309',
  '#BE123C',
  '#7E22CE',
  '#1D4ED8',
  '#475569',
];

/** The same colour for the same name, so a template without a logo keeps its look. */
function pick(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACKS[h % FALLBACKS.length];
}

/** Black or white writing, whichever reads on this colour. */
function ink(hex: string) {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#111827' : '#ffffff';
}

const initials = (name: string) =>
  name
    .split(/[\s-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

/**
 * A square logo: the brand's mark on its colour when there is one, else the name's initials on a colour of its own.
 * Used where something has a logo and something else does not, so a list reads as one.
 */
export function BrandTile({
  slug,
  name,
  className,
}: {
  /** A key of the bundled brand marks, or the https address of a public image */
  slug?: string;
  /** What it is called: the label, and the initials when there is no mark */
  name: string;
  className?: string;
}) {
  const url = slug && /^https:\/\//.test(slug) ? slug : undefined;
  // a picture that does not load (moved, blocked) falls back to the initials rather than a broken icon
  const [broken, setBroken] = useState(false);
  const mark = !url && slug ? BRAND_MARKS[slug] : undefined;
  if (url && !broken)
    return (
      <span
        role="img"
        aria-label={name}
        className={cn(
          'inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white shadow-xs',
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          crossOrigin="anonymous"
          className="h-full w-full object-contain p-1"
          onError={() => setBroken(true)}
        />
      </span>
    );
  const bg = mark ? `#${mark.hex}` : pick(name);
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 shadow-xs',
        className,
      )}
      style={{ backgroundColor: bg, color: ink(bg) }}
    >
      {mark ? (
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6 fill-current"
          aria-hidden="true"
        >
          <path d={mark.path} />
        </svg>
      ) : (
        <span className="text-sm font-semibold leading-none">
          {initials(name)}
        </span>
      )}
    </span>
  );
}
