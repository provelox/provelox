'use client';

import {
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useTransition } from 'react';
import { retryCertificateAction } from '@/actions/domains';
import { Button } from '@/components/ui/button';
import { apiGet } from '@/lib/client-api';
import {
  certificatePhase,
  diagnosisPollMs,
  retryWaitLabel,
  type CertificateDiagnosis,
  type CertificatePhase,
} from '@/lib/certificates';
import { describeDns } from '@/lib/dns-records';
import { cn } from '@/lib/utils';

/**
 * What is happening with one address's certificate: waiting, issued, or why not in plain words (HTTPS off, no email, DNS
 * missing or elsewhere, port 80, or Let's Encrypt's own refusal). It offers Retry certificate and Check DNS again, spaced
 * out so retries cannot use up Let's Encrypt's limit, and it stops asking once the certificate is issued.
 */
export function CertificatePanel({
  appName,
  host,
  onIssued,
  className,
}: {
  appName: string;
  host: string;
  onIssued?: () => void;
  className?: string;
}) {
  const qc = useQueryClient();
  const key = ['diagnosis', appName, host];
  const [retriedAt, setRetriedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, startRetry] = useTransition();
  const watching = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      apiGet<CertificateDiagnosis>(
        `certificates/${encodeURIComponent(appName)}/${encodeURIComponent(host)}`,
      ),
    refetchInterval: (q) =>
      diagnosisPollMs(
        certificatePhase(q.state.data, retriedAt, Date.now()),
        Date.now() - watching.current,
      ),
  });
  const d = query.data;
  const phase: CertificatePhase = certificatePhase(d, retriedAt, now);

  // The wait the server last reported, run down by the time since it said so
  const remaining = d
    ? Math.max(
        0,
        d.retryAfterSeconds - Math.floor((now - query.dataUpdatedAt) / 1000),
      )
    : 0;
  const wait = retryWaitLabel(remaining);

  // A clock for the countdown and for the end of "trying again", running only while one of them needs it
  const ticking = phase === 'retrying' || remaining > 0;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const issued = phase === 'issued';
  const told = useRef(false);
  useEffect(() => {
    if (issued && !told.current) {
      told.current = true;
      onIssued?.();
    }
  }, [issued, onIssued]);

  function retry() {
    setError(null);
    startRetry(async () => {
      const res = await retryCertificateAction(appName, host);
      if (!res.ok) {
        setError(res.error);
        void query.refetch();
        return;
      }
      watching.current = Date.now();
      setRetriedAt(Date.now());
      setNow(Date.now());
      await qc.invalidateQueries({ queryKey: key });
    });
  }

  if (!d && query.isError)
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        Could not check the certificate right now.
      </p>
    );

  const tone =
    phase === 'issued'
      ? 'ok'
      : phase === 'failed' || phase === 'warning'
        ? 'warn'
        : 'muted';
  const dns = d?.dns ? describeDns(host, d.dns) : null;
  const canAsk =
    !!d?.canRetry &&
    (phase === 'failed' || phase === 'warning' || phase === 'waiting');

  return (
    <div
      aria-live="polite"
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm',
        tone === 'ok' && 'border-emerald-500/40 bg-emerald-500/10',
        tone === 'warn' && 'border-amber-500/40 bg-amber-500/10',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {phase === 'checking' || phase === 'waiting' || phase === 'retrying' ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
        ) : phase === 'issued' ? (
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        )}
        <div className="min-w-0">
          <p className="font-medium">
            {phase === 'checking'
              ? 'Checking the certificate…'
              : phase === 'retrying'
                ? 'Asked the proxy to try again'
                : (d?.title ?? '')}
          </p>
          <p className="text-muted-foreground">
            {phase === 'retrying'
              ? 'The proxy notices within about 15 seconds and then asks Let’s Encrypt, which takes a few seconds more. This page updates by itself.'
              : d?.message}
          </p>
        </div>
      </div>

      {d?.acme && phase !== 'retrying' && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            What Let’s Encrypt said
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono">
            {d.acme.raw}
          </pre>
        </details>
      )}

      {dns && phase !== 'issued' && phase !== 'off' && (
        <p
          className={cn(
            'text-xs',
            dns.tone === 'ok'
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-muted-foreground',
          )}
        >
          DNS: {dns.text}
        </p>
      )}

      {d?.reason === 'no-email' && (
        <p className="text-xs">
          <Link
            href="/settings/general#domain"
            className="underline underline-offset-2"
          >
            Set the Let’s Encrypt email
          </Link>
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {(canAsk || phase === 'retrying') && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={retrying || remaining > 0 || phase === 'retrying'}
            onClick={retry}
          >
            {retrying ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCw className="size-4" />
            )}
            {wait ?? 'Retry certificate'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className={cn('size-4', query.isFetching && 'animate-spin')}
            />
            Check DNS again
          </Button>
          <span className="text-xs text-muted-foreground">
            Let’s Encrypt allows only a few failed attempts per hour for one
            name, so retries are spaced out (one a minute, three an hour).
          </span>
        </div>
      )}
    </div>
  );
}
