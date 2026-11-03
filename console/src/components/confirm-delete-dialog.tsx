'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Effects } from '@/lib/delete-effects';

/**
 * One confirmation for everything that is deleted: it says what goes and what stays, and the button only works once the
 * exact name has been typed (Enter in the field confirms too). `children` are extra choices that belong to the
 * deletion, such as "also delete the data".
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  /** The exact text that has to be typed */
  name,
  effects,
  confirmLabel,
  pending,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  name: string;
  effects: Effects;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  // a fresh box every time it opens: what was typed for one deletion must never confirm another
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  const ready = typed === name && !pending;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <AlertDialogContent className="max-h-[92vh] overflow-y-auto">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // the field itself, not the last render: Enter can arrive in the same instant as the last letter
            if (!pending && field.current?.value === name) onConfirm();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-left">
                <section aria-label="What is deleted">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider text-destructive">
                    Deleted
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    {effects.goes.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </section>
                <section aria-label="What is kept">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider">
                    Kept
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    {effects.stays.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </section>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {children}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm">
              Type <span className="font-mono font-medium">{name}</span> to
              confirm
            </label>
            <Input
              id={id}
              ref={field}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="font-mono"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!ready}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
