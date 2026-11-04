'use client';

import { CircleArrowUp, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  DISMISS_KEY,
  shouldShow,
  UPDATE_DOCS,
  type UpdateNotice,
} from '@/lib/updates';

/**
 * A line above every page when the project has published a newer release. It only tells: updating is a deliberate step
 * on the Updates page, where this line is not repeated. "Not now" is remembered in this browser for that release, and it
 * comes back for the next one.
 */
export function UpdateNoticeBar({ notice }: { notice: UpdateNotice }) {
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
  if (pathname.startsWith('/settings/updates')) return null;
  if (dismissed === undefined || !shouldShow(notice, dismissed)) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, notice.latest);
    } catch {
      // private mode: it is hidden until the page is loaded again
    }
    setDismissed(notice.latest);
  };
  const link = 'font-medium underline underline-offset-4 hover:no-underline';
  return (
    <div
      role="region"
      aria-label="Update available"
      data-testid="update-notice"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
    >
      <CircleArrowUp
        className="h-4 w-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1">
        {notice.imageMoved ? (
          <>
            <strong>Provelox {notice.latest}</strong> is out, but this server
            runs the image under its old name, which gets no more releases.
          </>
        ) : (
          <>
            <strong>Provelox {notice.latest}</strong> is available. You run{' '}
            {notice.current}.
          </>
        )}
      </p>
      <div className="flex items-center gap-4">
        {notice.notesUrl && (
          <a
            href={notice.notesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={link}
          >
            What changed
          </a>
        )}
        {notice.imageMoved ? (
          <a
            href={UPDATE_DOCS.oldImage}
            target="_blank"
            rel="noopener noreferrer"
            className={link}
          >
            How to move it
          </a>
        ) : (
          <Link href="/settings/updates" className={link}>
            {notice.canUpdate ? 'Update…' : 'How to update'}
          </Link>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label={`Hide this until a newer release than ${notice.latest}`}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
