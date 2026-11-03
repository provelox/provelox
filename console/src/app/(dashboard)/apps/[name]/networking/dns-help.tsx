'use client';

import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  checkDnsAction,
  enableCustomDomainSslAction,
  type DnsCheck,
} from '@/actions/domains';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  DNS_POLL_GIVE_UP_MS,
  DNS_POLL_MS,
  describeDns,
  dnsRecordsFor,
  type DnsRecord,
} from '@/lib/dns-records';
import { cn } from '@/lib/utils';

/**
 * What to create at the DNS provider so a domain reaches the app, with each part ready to copy, and a live check that
 * looks again every few seconds until DNS is right. When it is and HTTPS is off, one button turns HTTPS on.
 */
export function DnsHelp({
  host,
  defaultDomain,
  appName,
  httpsOffer,
  onState,
  className,
}: {
  host: string;
  /** The app's own address: what a subdomain's CNAME points at, and what its address records are read from */
  defaultDomain: string;
  appName?: string;
  /** The domain is attached with HTTPS off: offer to turn it on once DNS is right */
  httpsOffer?: { httpsReady: boolean; onEnabled?: () => void } | null;
  onState?: (check: DnsCheck | null) => void;
  className?: string;
}) {
  const [check, setCheck] = useState<DnsCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [gaveUp, setGaveUp] = useState(false);
  const [enabling, startEnable] = useTransition();
  const started = useRef(Date.now());
  const latest = useRef({ host, defaultDomain });
  latest.current = { host, defaultDomain };
  const report = useRef(onState);
  report.current = onState;

  const run = useCallback(async () => {
    setChecking(true);
    const { host: h, defaultDomain: d } = latest.current;
    const res = await checkDnsAction(h, d);
    // A reply for a domain that was edited since is dropped
    if (latest.current.host === h && res.ok && res.data) {
      setCheck(res.data);
      report.current?.(res.data);
    }
    setChecking(false);
  }, []);

  // Look now, and again every few seconds while it is not right, until a person has waited a long time
  useEffect(() => {
    started.current = Date.now();
    setGaveUp(false);
    setCheck(null);
    void run();
  }, [host, defaultDomain, run]);
  useEffect(() => {
    if (check?.state === 'match') return;
    const t = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - started.current > DNS_POLL_GIVE_UP_MS) {
        setGaveUp(true);
        clearInterval(t);
        return;
      }
      void run();
    }, DNS_POLL_MS);
    return () => clearInterval(t);
  }, [check?.state, run, host]);

  const { primary, alternative } = dnsRecordsFor({
    host,
    target: defaultDomain,
    addresses: check?.expected ?? [],
  });
  const status = check ? describeDns(host, check) : null;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <p className="text-sm">
        At your DNS provider, create{' '}
        {primary.length > 1 ? 'these records' : 'this record'} so{' '}
        <code>{host}</code> reaches this server:
      </p>
      <RecordList records={primary} />
      {alternative.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Or use address records instead of a CNAME
          </summary>
          <div className="mt-2">
            <RecordList records={alternative} />
          </div>
        </details>
      )}

      <div
        aria-live="polite"
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm',
          status?.tone === 'ok' && 'border-emerald-500/40 bg-emerald-500/10',
          status?.tone === 'warn' && 'border-amber-500/40 bg-amber-500/10',
        )}
      >
        <div className="flex min-w-0 items-start gap-2">
          {checking && !check ? (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
          ) : status?.tone === 'ok' ? (
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          )}
          <p>
            {status ? status.text : 'Checking DNS…'}
            {status && status.tone !== 'ok' && !gaveUp && check && (
              <span className="block text-xs text-muted-foreground">
                Looking again every few seconds.
              </span>
            )}
            {gaveUp && status?.tone !== 'ok' && (
              <span className="block text-xs text-muted-foreground">
                Stopped looking after 15 minutes. Check again once the record is
                saved.
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {httpsOffer &&
            check?.state === 'match' &&
            appName &&
            (httpsOffer.httpsReady ? (
              <Button
                size="sm"
                disabled={enabling}
                onClick={() =>
                  startEnable(async () => {
                    const res = await enableCustomDomainSslAction(
                      appName,
                      host,
                    );
                    if (res.ok) {
                      toast.success(`HTTPS turned on for ${host}`);
                      httpsOffer.onEnabled?.();
                    } else toast.error(res.error);
                  })
                }
              >
                {enabling && <Loader2 className="size-4 animate-spin" />}
                Turn on HTTPS
              </Button>
            ) : (
              <Link
                href="/settings/general#domain"
                className="text-xs underline underline-offset-2"
              >
                Set a Let’s Encrypt email to turn on HTTPS
              </Link>
            ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              started.current = Date.now();
              setGaveUp(false);
              void run();
            }}
            disabled={checking}
          >
            <RefreshCw className={cn('size-4', checking && 'animate-spin')} />
            Check now
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecordList({ records }: { records: DnsRecord[] }) {
  return (
    <div className="divide-y rounded-md border text-sm">
      {records.map((r) => (
        <div
          key={`${r.type}:${r.value}`}
          className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 p-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1.4fr)]"
        >
          <span className="font-mono text-xs font-semibold">{r.type}</span>
          <Field label="Name" value={r.name} hint={r.host} />
          <Field
            label="Value"
            value={r.value}
            copy={r.value !== 'this server’s address'}
          />
          <p className="col-span-full text-xs text-muted-foreground">
            {r.note}
          </p>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  copy = true,
}: {
  label: string;
  value: string;
  hint?: string;
  copy?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="break-all font-mono text-xs">{value}</p>
        {hint && value !== hint && (
          <p className="text-xs text-muted-foreground">for {hint}</p>
        )}
      </div>
      {copy && <CopyButton value={value} label="Copy" />}
    </div>
  );
}
