import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Fragment } from 'react';

export interface Crumb {
  label: string;
  /** The last crumb is the page you are on and has none */
  href?: string;
}

/** Where you are, as links back up: Apps / Group / app. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      {items.map((c, i) => (
        <Fragment key={`${i}-${c.label}`}>
          {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden="true" />}
          {c.href ? (
            <Link
              href={c.href}
              className="hover:text-foreground coarse:inline-block coarse:py-3"
            >
              {c.label}
            </Link>
          ) : (
            <span aria-current="page" className="text-foreground">
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
