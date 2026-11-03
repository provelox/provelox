'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  initialKeyState,
  readKey,
  SEARCH_SELECTORS,
  SHORTCUTS,
  type KeyState,
} from '@/lib/shortcuts';

const isTyping = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return (
    !!e &&
    (e.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) ||
      e.getAttribute?.('role') === 'combobox')
  );
};

/** A dialog, menu or the palette is open: the keys are for it. */
const somethingIsOpen = () =>
  !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  );

/**
 * The console's keyboard shortcuts (see lib/shortcuts.ts): g a, g t, g s, n, / and ?. `onSearchFallback` is what `/`
 * does when the page has no search box of its own.
 */
export function useShortcuts({
  onSearchFallback,
  onHelp,
}: {
  onSearchFallback: () => void;
  onHelp: () => void;
}) {
  const router = useRouter();
  const state = useRef<KeyState>(initialKeyState);
  // read through refs so the listener is added once
  const fallback = useRef(onSearchFallback);
  const help = useRef(onHelp);
  fallback.current = onSearchFallback;
  help.current = onHelp;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = readKey(state.current, {
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        typing: isTyping(e.target),
        blocked: somethingIsOpen(),
        now: Date.now(),
      });
      state.current = r.state;
      if (!r.handled) return;
      e.preventDefault();
      const c = r.command;
      if (!c) return;
      if (c.type === 'go') router.push(c.href);
      else if (c.type === 'new-app') router.push('/apps?new=1');
      else if (c.type === 'help') help.current();
      else if (c.type === 'search') {
        const box = SEARCH_SELECTORS.map((s) =>
          document.querySelector<HTMLInputElement>(s),
        ).find(Boolean);
        if (box) {
          box.focus();
          box.select?.();
        } else fallback.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);
}

/** The list of shortcuts, opened with ? or from the command palette. */
export function ShortcutsDialog({
  open,
  onOpenChange,
  isMac,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMac: boolean;
}) {
  const groups = ['Go to', 'Do', 'Find'] as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            They work anywhere except while you are typing in a field.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <section aria-labelledby="sc-everywhere">
            <h3
              id="sc-everywhere"
              className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Anywhere
            </h3>
            <Row keys={[isMac ? '⌘' : 'Ctrl', 'K']} label="Command palette" />
          </section>
          {groups.map((g) => (
            <section key={g} aria-labelledby={`sc-${g}`}>
              <h3
                id={`sc-${g}`}
                className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {g}
              </h3>
              <ul className="divide-y">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <li key={s.keys}>
                    <Row keys={s.keys.split(' ')} label={s.label} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span>{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && (
              <span className="text-xs text-muted-foreground">then</span>
            )}
            <kbd className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center font-sans text-xs">
              {k}
            </kbd>
          </span>
        ))}
      </span>
    </div>
  );
}
