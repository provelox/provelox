'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export interface SectionLink {
  id: string;
  label: string;
  /** A small figure beside the label: how many entries the section holds */
  count?: number;
}

/**
 * The "on this page" list for a tab that holds several sections. It follows the scroll, so you always see where you
 * are, and a link jumps to its section.
 */
export function SectionNav({ sections }: { sections: SectionLink[] }) {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -60% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Sections"
      className="sticky top-20 flex flex-col gap-0.5 text-sm"
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? 'location' : undefined}
          className={cn(
            'flex items-center justify-between rounded-md px-3 py-1.5',
            active === s.id
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {s.label}
          {s.count !== undefined && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {s.count}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}

/** A section of a tab: the anchor the nav jumps to, with room above for the sticky header. */
export function Section({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      {children}
    </section>
  );
}
