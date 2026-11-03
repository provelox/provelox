'use client';

import { Check, CircleDashed, ExternalLink, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { updateAppAction } from '@/actions/apps';
import {
  addCustomDomainAction,
  enableCustomDomainSslAction,
  type DnsCheck,
} from '@/actions/domains';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { siteUrl, type ProxyPorts } from '@/lib/site-url';
import { CertificatePanel } from './certificate-panel';
import { DnsHelp } from './dns-help';
import { cn } from '@/lib/utils';

const STEPS = ['Domain', 'DNS', 'HTTPS', 'Review'] as const;
type Step = 0 | 1 | 2 | 3;

const HOSTNAME =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** One thing the final step does, and how it went. */
type Task = { label: string; state: 'waiting' | 'running' | 'done' | 'failed' };

interface WizardProps {
  appName: string;
  /** The app's own address: what a custom domain's DNS should point at */
  defaultDomain: string;
  existing: string[];
  /** A Let's Encrypt email is set, so certificates can be issued */
  httpsReady: boolean;
  forceSsl: boolean;
  ports?: ProxyPorts;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddDomainWizard(props: WizardProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => !busy && props.onOpenChange(o)}
    >
      {/* Content unmounts when the dialog closes, so every opening starts clean */}
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <WizardBody {...props} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function WizardBody({
  appName,
  defaultDomain,
  existing,
  httpsReady,
  forceSsl,
  ports,
  onOpenChange,
  onBusyChange,
}: WizardProps & { onBusyChange: (busy: boolean) => void }) {
  const [step, setStep] = useState<Step>(0);
  const [host, setHost] = useState('');
  const [dns, setDns] = useState<DnsCheck | null>(null);
  const [https, setHttps] = useState(httpsReady);
  const attached = useRef(false);
  const [force, setForce] = useState(false);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = host.trim().toLowerCase();
  const problem = !value
    ? null
    : !HOSTNAME.test(value)
      ? 'Enter a domain such as app.example.com'
      : existing.includes(value)
        ? 'That domain is already attached.'
        : value === defaultDomain
          ? 'That is already this app’s default address.'
          : null;

  function next() {
    if (step === 0) setDns(null);
    setStep((s) => (s + 1) as Step);
  }

  async function submit() {
    onBusyChange(true);
    try {
      await run();
    } finally {
      onBusyChange(false);
    }
  }

  async function run() {
    setError(null);
    const plan: Task[] = [
      { label: `Attach ${value} to ${appName}`, state: 'running' },
      ...(https
        ? [
            {
              label: 'Request a certificate',
              state: 'waiting',
            } as Task,
          ]
        : []),
      ...(force
        ? [{ label: 'Redirect HTTP to HTTPS', state: 'waiting' } as Task]
        : []),
    ];
    const mark = (i: number, state: Task['state']) => {
      plan[i] = { ...plan[i], state };
      setTasks([...plan]);
    };
    setTasks([...plan]);

    if (!attached.current) {
      const added = await addCustomDomainAction(appName, value);
      if (!added.ok) {
        mark(0, 'failed');
        setError(added.error);
        return;
      }
      attached.current = true;
    }
    mark(0, 'done');
    let i = 1;
    if (https) {
      mark(i, 'running');
      const ssl = await enableCustomDomainSslAction(appName, value);
      if (!ssl.ok) {
        mark(i, 'failed');
        setError(
          `${value} is attached, but HTTPS could not be turned on: ${ssl.error} You can retry from the domains list.`,
        );
        return;
      }
      mark(i++, 'done');
    }
    if (force) {
      mark(i, 'running');
      const res = await updateAppAction(appName, { forceSsl: true });
      if (!res.ok) {
        mark(i, 'failed');
        setError(`HTTPS is on, but forcing it failed: ${res.error}`);
        return;
      }
      mark(i, 'done');
    }
  }

  const finished = tasks?.every((t) => t.state === 'done');
  const running = tasks?.some((t) => t.state === 'running');
  const canNext = step === 0 ? !!value && !problem : true;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a custom domain</DialogTitle>
        <DialogDescription>
          Serve {appName} on a domain you own.
        </DialogDescription>
      </DialogHeader>

      <ol className="flex items-center gap-2 text-sm" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5',
                i === step
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full text-xs',
                  i < step
                    ? 'bg-primary text-primary-foreground'
                    : i === step
                      ? 'border border-primary text-primary'
                      : 'border',
                )}
              >
                {i < step ? <Check className="size-3" /> : i + 1}
              </span>
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="h-px w-5 bg-border" />
            )}
          </li>
        ))}
      </ol>

      <div className="min-h-56 py-1">
        {step === 0 && (
          <div className="flex flex-col gap-2">
            <label htmlFor="wizard-domain" className="text-sm font-medium">
              Domain
            </label>
            <Input
              id="wizard-domain"
              autoFocus
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canNext) next();
              }}
              placeholder="app.example.com"
              className="font-mono"
              aria-invalid={!!problem}
            />
            {problem ? (
              <p className="text-sm text-destructive">{problem}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                A subdomain such as app.example.com, or a root domain such as
                example.com.
              </p>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-3">
            <DnsHelp
              host={value}
              defaultDomain={defaultDomain}
              onState={setDns}
            />
            <p className="text-xs text-muted-foreground">
              You can continue before DNS is ready. A certificate is issued only
              once the domain resolves here and port 80 is reachable; if it does
              not issue, the domains list shows why and lets you retry.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <RadioGroup
              value={https ? 'https' : 'http'}
              onValueChange={(v) => setHttps(v === 'https')}
            >
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border p-3',
                  !httpsReady && 'cursor-not-allowed opacity-60',
                  https && httpsReady && 'border-primary',
                )}
              >
                <RadioGroupItem
                  value="https"
                  disabled={!httpsReady}
                  className="mt-1"
                />
                <span className="text-sm">
                  <span className="font-medium">
                    Serve over HTTPS (recommended)
                  </span>
                  <span className="block text-muted-foreground">
                    A free certificate from Let’s Encrypt, renewed
                    automatically.
                  </span>
                  {!httpsReady && (
                    <span className="mt-1 block text-amber-700 dark:text-amber-400">
                      Set a Let’s Encrypt email under{' '}
                      <Link
                        href="/settings/general#domain"
                        className="underline underline-offset-2"
                      >
                        Settings, Domain & HTTPS
                      </Link>{' '}
                      first.
                    </span>
                  )}
                </span>
              </label>
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border p-3',
                  (!https || !httpsReady) && 'border-primary',
                )}
              >
                <RadioGroupItem value="http" className="mt-1" />
                <span className="text-sm">
                  <span className="font-medium">HTTP only for now</span>
                  <span className="block text-muted-foreground">
                    You can turn on HTTPS later from the domains list.
                  </span>
                </span>
              </label>
            </RadioGroup>
            <label
              className={cn(
                'flex items-start gap-3 text-sm',
                (!https || forceSsl) && 'opacity-60',
              )}
            >
              <Checkbox
                checked={force || forceSsl}
                disabled={!https || forceSsl}
                onCheckedChange={(c) => setForce(c === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Redirect HTTP to HTTPS</span>
                <span className="block text-muted-foreground">
                  {forceSsl
                    ? 'Already on for this app.'
                    : 'Applies to every domain of this app, not only this one.'}
                </span>
              </span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            {!tasks ? (
              <dl className="divide-y rounded-md border text-sm">
                <Summary label="Domain" value={value} mono />
                <Summary
                  label="Points at"
                  value={
                    dns?.state === 'match'
                      ? 'This server'
                      : dns?.state === 'none'
                        ? 'Nothing yet (DNS pending)'
                        : dns?.state === 'elsewhere'
                          ? `Another server (${dns.addresses[0]})`
                          : 'Not checked'
                  }
                />
                <Summary
                  label="HTTPS"
                  value={https ? 'Certificate from Let’s Encrypt' : 'Off'}
                />
                <Summary
                  label="Redirect to HTTPS"
                  value={force || forceSsl ? 'On' : 'Off'}
                />
              </dl>
            ) : (
              <ul className="flex flex-col gap-2 text-sm" aria-live="polite">
                {tasks.map((t) => (
                  <li key={t.label} className="flex items-center gap-2">
                    {t.state === 'done' && (
                      <Check className="size-4 text-emerald-600" />
                    )}
                    {t.state === 'running' && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {t.state === 'waiting' && (
                      <CircleDashed className="size-4 text-muted-foreground" />
                    )}
                    {t.state === 'failed' && (
                      <X className="size-4 text-destructive" />
                    )}
                    {t.label}
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {finished && https && (
              <CertificatePanel appName={appName} host={value} />
            )}
            {finished && (
              <a
                className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2"
                href={siteUrl({ host: value, ssl: https }, ports)}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open {value} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}
      </div>

      <DialogFooter>
        {finished ? (
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        ) : tasks ? (
          <>
            <Button
              variant="outline"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            {error && (
              <Button disabled={running} onClick={submit}>
                Try again
              </Button>
            )}
          </>
        ) : (
          <>
            {step > 0 ? (
              <Button
                variant="outline"
                onClick={() => setStep((s) => (s - 1) as Step)}
              >
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            )}
            {step < 3 ? (
              <Button disabled={!canNext} onClick={next}>
                Continue
              </Button>
            ) : (
              <Button onClick={submit}>Add domain</Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}

function Summary({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('text-right', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}
