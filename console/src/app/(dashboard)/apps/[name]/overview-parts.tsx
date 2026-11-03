import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { KpiIcon, kpiSurface, type KpiTone } from '@/components/ui/kpi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** One headline figure of the app, with what it is made of beneath. */
export function StatTile({
  label,
  children,
  detail,
  icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  children: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  tone?: KpiTone;
  className?: string;
}) {
  return (
    <div
      className={cn(kpiSurface(tone), 'flex flex-col gap-1.5 p-4', className)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon && <KpiIcon icon={icon} tone={tone} />}
      </div>
      <div className="min-w-0 text-lg font-semibold">{children}</div>
      {detail && (
        <div className="min-w-0 text-xs text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}

/** A labelled list of facts: names, values, and a copy-friendly monospace where it is an identifier. */
export function Facts({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: ReactNode; mono?: boolean }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y text-sm">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-baseline justify-between gap-4 py-2"
            >
              <dt className="shrink-0 text-muted-foreground">{r.label}</dt>
              <dd
                className={cn(
                  'min-w-0 truncate text-right',
                  r.mono && 'font-mono text-xs',
                )}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Jumps into a section of the Configuration or Networking tab. */
export function ConfigLink({
  href,
  label,
  count,
  hint,
}: {
  href: string;
  label: string;
  count: number;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent"
    >
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <span className="text-lg font-semibold tabular-nums">{count}</span>
    </Link>
  );
}
