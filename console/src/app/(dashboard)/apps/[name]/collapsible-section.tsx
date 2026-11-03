import { ChevronRight } from 'lucide-react';

/**
 * A card that starts closed, for settings most apps never touch. The title and a one-line summary stay visible, so it
 * is clear what is inside and whether anything is set.
 */
export function CollapsibleSection({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border bg-card text-card-foreground"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-base font-semibold">{title}</span>
          <span className="block text-sm text-muted-foreground">{summary}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t [&>div]:rounded-none [&>div]:border-0">
        {children}
      </div>
    </details>
  );
}
