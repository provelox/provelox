'use client';

import { Check, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { formatWait, nextDelayMs, SLOW_AFTER_SECONDS } from '@/lib/waiting';

type Api = 'checking' | 'down' | 'ok';

export async function apiIsUp(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    // The console answered but could not say the API is up (it is itself unwell): the API counts as down
    if (!res.ok) return false;
    return (
      ((await res.json().catch(() => ({}))) as { api?: string }).api === 'ok'
    );
  } catch {
    return null; // this browser cannot reach the console itself
  }
}

/**
 * What the console shows while the API is not answering, instead of an error: it says what is going on, that apps
 * are not affected, how long it has been, and loads the page again by itself the moment the API is back.
 *
 * With `variant="error"` (an unexpected failure) it first asks whether the API is up. If it is, the failure was
 * something else and the screen says so plainly; if it is not, this is the same waiting.
 */
export function WaitingScreen({
  variant = 'waiting',
  digest,
  reset,
  compact = false,
}: {
  variant?: 'waiting' | 'error';
  digest?: string;
  reset?: () => void;
  /** Inside the console's own frame rather than the whole window */
  compact?: boolean;
}) {
  const [api, setApi] = useState<Api>(
    variant === 'waiting' ? 'down' : 'checking',
  );
  const [offline, setOffline] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const check = useCallback(async () => {
    clearTimeout(timer.current);
    const up = await apiIsUp();
    setOffline(up === null);
    if (up) {
      setApi('ok');
      // A moment to read "back", then the page asks for fresh data
      setTimeout(() => window.location.reload(), 700);
      return;
    }
    setApi('down');
    attempt.current += 1;
    timer.current = setTimeout(check, nextDelayMs(attempt.current));
  }, []);

  useEffect(() => {
    if (variant === 'waiting') {
      timer.current = setTimeout(check, 1200);
    } else {
      // An unexpected error: find out whether the API is the reason, without reloading if it is not
      void apiIsUp().then((up) => {
        if (up === false || up === null) {
          setOffline(up === null);
          setApi('down');
          timer.current = setTimeout(check, nextDelayMs(0));
        } else setApi('ok');
      });
    }
    return () => clearTimeout(timer.current);
  }, [variant, check]);

  useEffect(() => {
    if (api !== 'down') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [api]);

  const waiting = api === 'down';
  const failedForAnotherReason = variant === 'error' && api === 'ok';
  const slow = waiting && seconds >= SLOW_AFTER_SECONDS;

  return (
    <div
      className={
        compact
          ? 'flex justify-center py-16'
          : 'flex min-h-screen items-center justify-center bg-background p-6 text-foreground'
      }
    >
      <div className="flex w-full max-w-md flex-col items-start gap-6">
        <Logo />

        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <h1 className="text-2xl font-bold tracking-tight">
            {failedForAnotherReason
              ? 'Something went wrong'
              : offline
                ? 'This browser cannot reach the console'
                : api === 'checking'
                  ? 'One moment'
                  : api === 'ok'
                    ? 'Provelox is back'
                    : 'Provelox is getting ready'}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {failedForAnotherReason
              ? 'The API is running, but this page could not be put together. Try again; if it keeps happening, the console’s log says why.'
              : offline
                ? 'Check your own connection. This page keeps trying and will load by itself when it can.'
                : api === 'ok'
                  ? 'Loading your console…'
                  : 'The console cannot reach the Provelox API yet. That is normal for a minute or so while Provelox updates or restarts. This page loads by itself as soon as the API answers.'}
          </p>
        </div>

        {!failedForAnotherReason && (
          <ul className="flex w-full flex-col gap-2.5 rounded-xl border bg-card p-4 text-sm">
            <Step done label="Console" detail="You are looking at it" />
            <Step
              done={api === 'ok'}
              working={waiting || api === 'checking'}
              label="API"
              detail={
                api === 'ok'
                  ? 'Answering'
                  : api === 'checking'
                    ? 'Checking…'
                    : `Waiting ${formatWait(seconds)}`
              }
            />
            <Step
              done
              label="Your apps"
              detail="Not affected: they keep running"
            />
          </ul>
        )}

        {slow && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">This is taking longer than usual.</p>
            <p className="text-muted-foreground">
              If an update was running, Docker puts the old version back by
              itself when the new one does not start. To see what is happening,
              run these on the server:
            </p>
            <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
              {
                'docker service ps pvx-provelox\ndocker service logs pvx-provelox --tail 50'
              }
            </pre>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {failedForAnotherReason && reset && (
            <Button onClick={reset}>Try again</Button>
          )}
          {waiting && (
            <Button
              variant="outline"
              onClick={() => {
                attempt.current = 0;
                void check();
              }}
            >
              Check now
            </Button>
          )}
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>

        {digest && (
          <p className="font-mono text-xs text-muted-foreground">
            Reference {digest}
          </p>
        )}
      </div>
    </div>
  );
}

function Step({
  label,
  detail,
  done,
  working,
}: {
  label: string;
  detail: string;
  done?: boolean;
  working?: boolean;
}) {
  return (
    <li className="flex items-center gap-3">
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        {done ? (
          <Check className="h-4 w-4 text-emerald-500" />
        ) : working ? (
          <Loader2 className="h-4 w-4 motion-safe:animate-spin text-primary" />
        ) : null}
      </span>
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-muted-foreground">{detail}</span>
    </li>
  );
}
