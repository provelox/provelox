'use client';

import { ArrowRight, Check, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  nextStep,
  progress,
  shouldShow,
  type FirstRunMemory,
  type FirstRunStep,
} from '@/lib/first-run';
import { cn } from '@/lib/utils';

const KEY = 'provelox:first-run';

function read(): FirstRunMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function write(memory: FirstRunMemory) {
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // storage unavailable: it just comes back next time, which is harmless
  }
}

/**
 * The checklist for a new instance: what is done, what is next, and a way to hide it. What counts as done is worked out
 * on the server from real state; this only draws it and remembers, in this browser, that it was shown and whether it
 * was hidden.
 */
export function FirstRunCard({
  steps,
  appCount,
}: {
  steps: FirstRunStep[];
  appCount: number;
}) {
  const [memory, setMemory] = useState<FirstRunMemory | null>(null);
  const { done, total } = progress(steps);
  const complete = done === total;

  useEffect(() => {
    const m = read();
    // seen on an empty instance: it stays until it is finished or hidden, even once the first app exists
    if (appCount === 0 && !m.started && !m.dismissed) {
      m.started = true;
      write(m);
    }
    setMemory(m);
  }, [appCount]);

  if (!memory || !shouldShow({ appCount, complete, memory })) return null;
  const next = nextStep(steps);

  return (
    <section
      aria-labelledby="first-run-title"
      className="rounded-lg border bg-card p-5 shadow-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="first-run-title" className="text-base font-semibold">
            {appCount === 0
              ? 'Welcome. Let’s get your first app running'
              : 'Finish setting up'}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {done} of {total} done
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Hide the checklist"
          title="Hide the checklist"
          onClick={() => {
            const m = { ...memory, dismissed: true };
            write(m);
            setMemory(m);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
      <ol className="mt-4 divide-y">
        {steps.map((s) => {
          const isNext = next?.id === s.id;
          return (
            <li
              key={s.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-primary-foreground',
                    s.done
                      ? 'border-emerald-500 bg-emerald-500'
                      : isNext
                        ? 'border-primary'
                        : 'border-muted-foreground/40',
                  )}
                >
                  {s.done && <Check className="h-3 w-3" />}
                </span>
                <div className="min-w-0">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      s.done && 'text-muted-foreground line-through',
                    )}
                  >
                    {s.title}
                    <span className="sr-only">
                      {s.done ? ' (done)' : isNext ? ' (next)' : ''}
                    </span>
                  </p>
                  {!s.done && (
                    <p className="text-xs text-muted-foreground">{s.detail}</p>
                  )}
                </div>
              </div>
              {!s.done && (
                <Button
                  asChild
                  size="sm"
                  variant={isNext ? 'default' : 'outline'}
                  className="self-start sm:self-auto"
                >
                  <Link href={s.href}>
                    {s.action}
                    {isNext && <ArrowRight className="h-3.5 w-3.5" />}
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
