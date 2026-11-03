'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useState, useTransition } from 'react';
import { checkSecurityAction } from '@/actions/security-checks';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/format';
import {
  groupFindings,
  SEVERITY_TITLE,
  verdict,
  type SecurityFinding,
  type SecurityScan,
} from '@/lib/security';
import { cn } from '@/lib/utils';

const ICON = {
  critical: ShieldAlert,
  warning: AlertTriangle,
  info: Info,
} as const;

const TONE: Record<SecurityFinding['severity'], string> = {
  critical: 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300',
  warning:
    'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300',
  info: 'border-border bg-secondary/30 text-muted-foreground',
};

const VERDICT_TONE = {
  none: 'border-border bg-secondary/30',
  good: 'border-emerald-500/40 bg-emerald-500/5',
  warn: 'border-amber-500/40 bg-amber-500/5',
  bad: 'border-red-500/40 bg-red-500/5',
} as const;

/** What the check found, worst first, with a button to look again. */
export function SecurityView({ initial }: { initial: SecurityScan }) {
  const [scan, setScan] = useState(initial);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const check = () =>
    startTransition(async () => {
      setError(undefined);
      const res = await checkSecurityAction();
      if (!res.ok || !res.data)
        return void setError(res.ok ? 'Nothing came back.' : res.error);
      setScan(res.data);
    });

  const v = verdict(scan);
  const groups = groupFindings(scan.findings);

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border p-4 text-sm">
        <p className="font-medium">What this looks at</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Apps that publish a database or other private service to the whole
            internet.
          </li>
          <li>
            Work the processor does that no app accounts for (a hidden
            cryptocurrency miner looks like this).
          </li>
          <li>
            On the machine itself, read only: a library forced into every
            program, a second root account, processes running from temporary
            places, scheduled jobs that start something hidden, SSH settings and
            keys, and whether Docker is open to the network.
          </li>
        </ul>
        <p className="mt-2 text-muted-foreground">
          It never changes anything. If it finds the machine itself has been
          taken over, rebuild it.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <p className="font-medium">This check is not exhaustive</p>
        <p className="mt-1 text-muted-foreground">
          It looks for common, well-known signs. A clean result does not mean
          the machine is safe, and an attacker who knows these checks can avoid
          them. It cannot see, among other things:
        </p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Malware that hides at the level of the operating system itself, or
            that lives only in memory.
          </li>
          <li>
            What happens inside your apps and their containers: weak or leaked
            passwords, outdated software, or a flaw in an app&apos;s own code.
          </li>
          <li>
            Other machines of a cluster. Each machine checks only itself, so
            look at every one.
          </li>
          <li>
            Who got in earlier and what they took. Logs on a machine that
            someone controls can be changed.
          </li>
        </ul>
        <p className="mt-2 text-muted-foreground">
          Treat it as a smoke detector, not an inspection: keep software
          updated, turn off password login for SSH, and keep databases off the
          internet.
        </p>
      </div>

      <div
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-lg border p-4',
          VERDICT_TONE[v.tone],
        )}
        role={v.tone === 'bad' ? 'alert' : 'status'}
      >
        {v.tone === 'good' ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
        ) : v.tone === 'bad' ? (
          <ShieldAlert className="h-5 w-5 shrink-0 text-red-600" />
        ) : (
          <ShieldCheck className="h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{v.text}</p>
          {scan.at && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Checked {timeAgo(scan.at)}
              {!scan.hostChecked && scan.hostError
                ? `. The machine could not be checked: ${scan.hostError}`
                : ''}
            </p>
          )}
        </div>
        <Button onClick={check} disabled={pending} size="sm">
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {scan.at && groups.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing to report.
        </p>
      )}

      {groups.map((g) => {
        const Icon = ICON[g.severity];
        return (
          <section key={g.severity} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {SEVERITY_TITLE[g.severity]}{' '}
              <span className="font-normal text-muted-foreground">
                ({g.findings.length})
              </span>
            </h3>
            {g.findings.map((f) => (
              <article
                key={f.id}
                className={cn('rounded-lg border p-3', TONE[g.severity])}
              >
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 text-foreground">
                    <p className="text-sm font-medium">{f.title}</p>
                    <p className="mt-1 break-words text-sm text-muted-foreground">
                      {f.detail}
                    </p>
                    {f.fix && (
                      <p className="mt-2 text-sm">
                        <span className="font-medium">What to do: </span>
                        {f.fix}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
