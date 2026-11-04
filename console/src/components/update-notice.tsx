'use client';

import { CircleArrowUp } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  DISMISS_KEY,
  shouldShow,
  STEP_NAME,
  UPDATE_DOCS,
  type UpdateNotice,
} from '@/lib/updates';
import { formatVersion } from '@/lib/version';

/**
 * That a newer release exists, told in two quiet places instead of a bar above every page: a small indicator in the
 * header, and a chip beside the version in the sidebar. Both open the same short explanation. It only tells: updating
 * is a deliberate step on the Updates page, which neither repeats. "Hide" is remembered in this browser for that
 * release (the header indicator goes; the sidebar chip stays, so it can always be found), and it comes back for the
 * next one.
 */
export function useUpdateIndicator(notice: UpdateNotice | null) {
  const pathname = usePathname();
  // undefined until the browser has been asked, so the server's page and the first paint agree
  const [dismissed, setDismissed] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY));
    } catch {
      setDismissed(null);
    }
  }, []);
  const onUpdatesPage = pathname.startsWith('/settings/updates');
  return {
    /** The sidebar chip: whenever there is a newer release, except on the page that is about it */
    chip: !!notice && !onUpdatesPage,
    /** The header indicator: also not after "Hide", for that release */
    bell:
      !!notice &&
      !onUpdatesPage &&
      dismissed !== undefined &&
      shouldShow(notice, dismissed),
    dismiss(latest: string) {
      try {
        localStorage.setItem(DISMISS_KEY, latest);
      } catch {
        // private mode: it is hidden until the page is loaded again
      }
      setDismissed(latest);
    },
  };
}

/** What a person needs before deciding: which release, what it means for them, and where to go next */
function UpdatePanel({
  notice,
  onHide,
  onNavigate,
}: {
  notice: UpdateNotice;
  onHide?: () => void;
  onNavigate: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Update available"
      data-testid="update-notice"
      className="flex flex-col gap-3 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
          <CircleArrowUp className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Provelox {notice.latest} is{' '}
            {notice.imageMoved ? 'out' : 'available'}
          </p>
          <p className="text-xs text-muted-foreground">
            {notice.imageMoved
              ? 'This server runs the image under its old name, which gets no more releases.'
              : `You run ${notice.current}.`}
          </p>
        </div>
      </div>
      {notice.careful && !notice.imageMoved && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          This is {STEP_NAME[notice.step]}. Before 1.0 it can change what
          Provelox stores, so copy the data volume first.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {notice.imageMoved ? (
          <Button asChild size="sm">
            <a
              href={UPDATE_DOCS.oldImage}
              target="_blank"
              rel="noopener noreferrer"
            >
              How to move it
            </a>
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link href="/settings/updates" onClick={onNavigate}>
              {notice.canUpdate ? 'Update…' : 'How to update'}
            </Link>
          </Button>
        )}
        {notice.hasNotes ? (
          <Button asChild size="sm" variant="outline">
            <Link href="/settings/updates#whats-new" onClick={onNavigate}>
              What changed
            </Link>
          </Button>
        ) : (
          notice.notesUrl && (
            <Button asChild size="sm" variant="outline">
              <a
                href={notice.notesUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                What changed
              </a>
            </Button>
          )
        )}
      </div>
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          className="self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Hide until the next release
        </button>
      )}
    </div>
  );
}

/** The header indicator: an arrow with a dot that pings twice when it appears, then stays still */
export function UpdateBell({
  notice,
  onHide,
}: {
  notice: UpdateNotice;
  onHide: () => void;
}) {
  const [open, setOpen] = useState(false);
  // leaving is a short fade, not a cut: the indicator is told "Hide" and shrinks away before it is removed
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = () => {
    setOpen(false);
    setLeaving(true);
    // the button that was just pressed is about to go with the indicator: keep a keyboard user's place by moving focus
    // to the chip beside the version, which stays, or else to the page's search
    (
      document.querySelector<HTMLElement>('[data-testid="update-chip"]') ??
      document.querySelector<HTMLElement>(
        'button[aria-label^="Search"], header button',
      )
    )?.focus();
    timer.current = window.setTimeout(onHide, 160);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Update available: Provelox ${notice.latest}`}
          data-testid="update-bell"
          className={`relative h-9 w-9 duration-150 animate-in fade-in-0 zoom-in-50 slide-in-from-top-1 ${
            leaving
              ? 'scale-75 opacity-0 transition-[opacity,transform]'
              : 'transition-colors'
          }`}
        >
          <CircleArrowUp className="h-5 w-5 text-primary" />
          <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
            <span
              aria-hidden="true"
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 [animation-iteration-count:2]"
            />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80">
        <UpdatePanel
          notice={notice}
          onHide={hide}
          onNavigate={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The sidebar chip beside the version: the same explanation, wherever you look for the version */
export function UpdateChip({ notice }: { notice: UpdateNotice }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // the name must contain the words on the button ("v0.5.1"), so voice control and screen readers agree
          aria-label={`Update available: ${formatVersion(notice.latest)}`}
          data-testid="update-chip"
          className="inline-flex animate-in items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors duration-200 fade-in-0 slide-in-from-left-1 hover:bg-primary/20"
        >
          <CircleArrowUp className="h-3 w-3 text-primary" aria-hidden="true" />
          {formatVersion(notice.latest)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80">
        <UpdatePanel notice={notice} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
