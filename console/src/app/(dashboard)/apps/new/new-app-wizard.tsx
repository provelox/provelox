'use client';

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Database,
  Loader2,
  Rocket,
  Server,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { createAppWizardAction, type WizardResult } from '@/actions/apps';
import { createGroupAction } from '@/actions/groups';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Combobox } from '@/components/ui/combobox';
import { DeployFailure } from '@/components/deploy-failure';
import {
  collectionForProduct,
  explainAppName,
  suggestAppName,
  suggestFromDomain,
} from '@/lib/app-name';
import { apiGet } from '@/lib/client-api';
import { explainGroupName } from '@/lib/groups';
import type { BuildStatus } from '@/lib/types';
import {
  deployPhase,
  firstInvalidStep,
  initialWizardState,
  parsePort,
  problemWith,
  WIZARD_STEPS,
  type WizardState,
  type WizardStepId,
} from '@/lib/wizard';
import { dnsRecordsFor } from '@/lib/dns-records';
import { cn } from '@/lib/utils';

interface GroupOption {
  id: string;
  name: string;
}

const STEP_LABEL: Record<string, string> = {
  register: 'Create the app',
  group: 'Add it to a collection',
  port: 'Set the container port',
  domain: 'Attach the domain',
  'ci-key': 'Create the CI deploy key',
  deploy: 'Start the deploy',
};

export function NewAppWizard({
  existingApps,
  groups: initialGroups,
  initialGroupId,
  rootDomain,
  defaultSubdomain,
  onClose,
  onBusyChange,
}: {
  existingApps: string[];
  groups: GroupOption[];
  initialGroupId: string | null;
  /** The domain apps are served under, and whether new apps get a default address on it unless told otherwise */
  rootDomain: string;
  defaultSubdomain: boolean;
  /** Called by the "Back to apps" button once the app is created */
  onClose: () => void;
  /** True while the app is being created, so the host can refuse to close */
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<WizardState>(
    initialWizardState(initialGroupId, defaultSubdomain),
  );
  const [step, setStep] = useState<WizardStepId>('basics');
  const [reached, setReached] = useState(0);
  const [groups, setGroups] = useState(initialGroups);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string>();
  const groupInput = useRef<HTMLInputElement>(null);
  const addingGroup = newGroup !== null;
  // Radix puts focus back on the select when it closes; move it on to the new field afterwards
  useEffect(() => {
    if (!addingGroup) return;
    const t = setTimeout(() => groupInput.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [addingGroup]);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<WizardResult>();
  const [pending, startTransition] = useTransition();

  useEffect(() => onBusyChange?.(pending), [pending, onBusyChange]);

  const index = WIZARD_STEPS.findIndex((s) => s.id === step);
  const set = (patch: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...patch }));
    setError(undefined);
  };
  const problem = problemWith(step, state, existingApps);
  const nameHint = explainAppName(state.name);
  const suggestion = suggestAppName(state.name);
  // A domain typed where the name goes: offer the name the platform recommends for it, and to attach the domain
  const fromDomain = suggestFromDomain(state.name);
  const productGroup = fromDomain
    ? collectionForProduct(fromDomain.product, groups)
    : null;
  const groupName = groups.find((g) => g.id === state.groupId)?.name;

  const go = (id: WizardStepId) => {
    setStep(id);
    setError(undefined);
    setReached((r) =>
      Math.max(
        r,
        WIZARD_STEPS.findIndex((s) => s.id === id),
      ),
    );
  };

  const create = () => {
    const bad = firstInvalidStep(state, existingApps);
    if (bad) return go(bad);
    startTransition(async () => {
      const res = await createAppWizardAction({
        name: state.name,
        hasPersistentData: state.persistent,
        groupId: state.groupId,
        containerHttpPort: parsePort(state.port) ?? 80,
        image: state.deployNow ? state.image.trim() : '',
        ciKeyName: state.ciKey ? `${state.name} CI` : null,
        defaultSubdomain: state.defaultSubdomain,
        domain: state.domain,
      });
      if (!res.ok) return setError(res.error);
      setResult(res.data);
      router.refresh();
    });
  };

  const createGroup = () => {
    const name = newGroup ?? '';
    const bad = explainGroupName(name, {
      groups: groups.map((g) => ({ ...g, appNames: [] })),
    });
    if (bad) return setGroupError(bad);
    startTransition(async () => {
      const res = await createGroupAction(name);
      if (!res.ok || !res.data)
        return setGroupError(
          res.ok ? 'Could not create the collection' : res.error,
        );
      setGroups((g) => [
        ...g,
        { id: res.data as string, name: name.trim().replace(/\s+/g, ' ') },
      ]);
      set({ groupId: res.data });
      setNewGroup(null);
      setGroupError(undefined);
    });
  };

  if (result)
    return (
      <Done
        onClose={onClose}
        state={state}
        result={result}
        rootDomain={rootDomain}
        onAnother={() => {
          setResult(undefined);
          setState(initialWizardState(state.groupId));
          setStep('basics');
          setReached(0);
        }}
      />
    );

  const next = () => {
    if (problem) return setError(problem);
    go(WIZARD_STEPS[index + 1].id);
  };

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex items-center gap-2" aria-label="Steps">
        {WIZARD_STEPS.map((s, i) => {
          const done = i < index;
          const reachable = i <= reached && i !== index;
          return (
            <li
              key={s.id}
              className="flex flex-1 items-center gap-2 last:flex-none"
            >
              <button
                type="button"
                disabled={!reachable}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => go(s.id)}
                className="flex items-center gap-2 text-sm disabled:cursor-default"
              >
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full border text-xs',
                    i === index &&
                      'border-primary bg-primary text-primary-foreground',
                    done && 'border-primary text-primary',
                    i > index && 'text-muted-foreground',
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    'hidden sm:inline',
                    i === index ? 'font-medium' : 'text-muted-foreground',
                  )}
                >
                  {s.label}
                </span>
              </button>
              {i < WIZARD_STEPS.length - 1 && (
                <span className="h-px flex-1 bg-border" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'review') create();
          else next();
        }}
      >
        <Card className="border-0 bg-transparent">
          {step === 'basics' && (
            <>
              <CardHeader>
                <CardTitle>Name your app</CardTitle>
                <CardDescription>
                  The name is how other apps reach it and where its default
                  address starts. Typing a domain such as api.example.com
                  suggests a name for it.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="app-name" className="text-sm font-medium">
                    App name
                  </label>
                  <Input
                    id="app-name"
                    autoFocus
                    value={state.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder="e.g. shop-api"
                    autoComplete="off"
                    spellCheck={false}
                    className="max-w-sm font-mono"
                    aria-invalid={!!(nameHint || error)}
                  />
                  {fromDomain ? (
                    <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                      <p>
                        <span className="font-mono">{fromDomain.host}</span>{' '}
                        looks like a domain. Name the app for what it is and
                        keep the domain as its address:
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono text-foreground">
                          {fromDomain.name}
                        </span>{' '}
                        (product <b>{fromDomain.product}</b>, role{' '}
                        <b>{fromDomain.role}</b>)
                        {productGroup && (
                          <>
                            , in the <b>{productGroup.name}</b> collection
                          </>
                        )}
                        , with {fromDomain.host} attached.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() =>
                            set({
                              name: fromDomain.name,
                              domain: fromDomain.host,
                              groupId: productGroup?.id ?? state.groupId,
                            })
                          }
                        >
                          Use {fromDomain.name}
                        </Button>
                        {suggestion && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => set({ name: suggestion })}
                          >
                            Just use {suggestion}
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    nameHint && (
                      <p className="text-xs text-destructive">
                        {nameHint}{' '}
                        {suggestion && (
                          <button
                            type="button"
                            className="underline"
                            onClick={() => set({ name: suggestion })}
                          >
                            Use {suggestion}
                          </button>
                        )}
                      </p>
                    )
                  )}
                  {state.domain && (
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>
                        Will also serve{' '}
                        <span className="font-mono text-foreground">
                          {state.domain}
                        </span>
                        . Point its DNS at this server, then turn on HTTPS under
                        Networking.
                      </span>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => set({ domain: '' })}
                      >
                        Remove
                      </button>
                    </p>
                  )}
                  {!nameHint && existingApps.includes(state.name) && (
                    <p className="text-xs text-destructive">
                      An app with that name already exists.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="group" className="text-sm font-medium">
                    Collection{' '}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </label>
                  <Combobox
                    value={state.groupId ?? 'none'}
                    onValueChange={(v) => {
                      if (v === '__new') return setNewGroup('');
                      set({ groupId: v === 'none' ? null : v });
                    }}
                    id="group"
                    className="w-64"
                    searchPlaceholder="Search collections"
                    options={[
                      { value: 'none', label: 'No collection' },
                      ...groups.map((g) => ({ value: g.id, label: g.name })),
                      { value: '__new', label: 'New collection…' },
                    ]}
                  />
                  {newGroup !== null && (
                    <div className="mt-1 flex flex-col gap-1">
                      <div className="flex max-w-sm gap-2">
                        <Input
                          ref={groupInput}
                          value={newGroup}
                          onChange={(e) => {
                            setNewGroup(e.target.value);
                            setGroupError(undefined);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              createGroup();
                            }
                          }}
                          placeholder="Collection name, e.g. Online shop"
                          aria-label="New collection name"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={createGroup}
                        >
                          Create
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setNewGroup(null);
                            setGroupError(undefined);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                      {groupError && (
                        <p className="text-xs text-destructive">{groupError}</p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    A collection holds the apps of one product, like its API,
                    site and portal.
                  </p>
                </div>
              </CardContent>
            </>
          )}

          {step === 'runtime' && (
            <>
              <CardHeader>
                <CardTitle>How does it run?</CardTitle>
                <CardDescription>
                  Decide whether the app keeps data and which port it listens
                  on.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <RadioGroup
                  value={state.persistent ? 'data' : 'stateless'}
                  onValueChange={(v) => set({ persistent: v === 'data' })}
                  className="grid gap-2 sm:grid-cols-2"
                  aria-label="Data"
                >
                  {(
                    [
                      [
                        'stateless',
                        Server,
                        'Stateless',
                        'APIs, websites and workers. Can run several instances and move between servers.',
                      ],
                      [
                        'data',
                        Database,
                        'Keeps data',
                        'Databases, uploads, anything written to disk. Runs one instance on one server. Cannot be changed later.',
                      ],
                    ] as const
                  ).map(([value, Icon, title, hint]) => (
                    <label
                      key={value}
                      className={cn(
                        'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm',
                        (state.persistent ? 'data' : 'stateless') === value
                          ? 'border-primary'
                          : 'border-input',
                      )}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <RadioGroupItem value={value} />
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        {title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {hint}
                      </span>
                    </label>
                  ))}
                </RadioGroup>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="port" className="text-sm font-medium">
                    Container port
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="port"
                      inputMode="numeric"
                      value={state.port}
                      onChange={(e) => set({ port: e.target.value.trim() })}
                      className="w-28 font-mono"
                      aria-invalid={!!problem}
                    />
                    {['80', '3000', '8080'].map((p) => (
                      <Button
                        key={p}
                        type="button"
                        size="sm"
                        variant={state.port === p ? 'outline' : 'ghost'}
                        onClick={() => set({ port: p })}
                      >
                        {p}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The port your app listens on inside its container. Web
                    traffic is sent there.
                  </p>
                </div>

                <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
                  <Checkbox
                    checked={state.defaultSubdomain}
                    onCheckedChange={(c) =>
                      set({ defaultSubdomain: c === true })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      Serve at{' '}
                      <span className="font-mono">
                        {state.name || 'app-name'}.{rootDomain || 'your-domain'}
                      </span>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {state.defaultSubdomain
                        ? 'The app is reachable at its default address. You can add your own domains later.'
                        : 'No default address. The app is reachable only on domains you add, and by other apps on the server.'}
                      {!defaultSubdomain &&
                        ' Your platform setting leaves this off for new apps.'}
                    </span>
                  </span>
                </label>
              </CardContent>
            </>
          )}

          {step === 'deploy' && (
            <>
              <CardHeader>
                <CardTitle>Put something on it</CardTitle>
                <CardDescription>
                  Until it is deployed the app shows the placeholder page. You
                  can always deploy later.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <RadioGroup
                  value={state.deployNow ? 'now' : 'later'}
                  onValueChange={(v) => set({ deployNow: v === 'now' })}
                  className="grid gap-2 sm:grid-cols-2"
                  aria-label="Deploy"
                >
                  {(
                    [
                      [
                        'now',
                        'Deploy an image now',
                        'Pull a Docker image from a registry and start it.',
                      ],
                      [
                        'later',
                        'Deploy later',
                        'Create the app empty. Deploy from this console or from CI.',
                      ],
                    ] as const
                  ).map(([value, title, hint]) => (
                    <label
                      key={value}
                      className={cn(
                        'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm',
                        (state.deployNow ? 'now' : 'later') === value
                          ? 'border-primary'
                          : 'border-input',
                      )}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <RadioGroupItem value={value} />
                        {title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {hint}
                      </span>
                    </label>
                  ))}
                </RadioGroup>

                {state.deployNow && (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="image" className="text-sm font-medium">
                      Image
                    </label>
                    <Input
                      id="image"
                      autoFocus
                      value={state.image}
                      onChange={(e) => set({ image: e.target.value })}
                      placeholder="ghcr.io/org/app:tag"
                      spellCheck={false}
                      className="max-w-lg font-mono"
                      aria-invalid={!!problem}
                    />
                    <p className="text-xs text-muted-foreground">
                      Private images need their registry under Settings →
                      Registries first.
                    </p>
                  </div>
                )}

                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={state.ciKey}
                    onCheckedChange={(c) => set({ ciKey: c === true })}
                  />
                  <span>
                    Create a CI deploy key
                    <span className="block text-xs text-muted-foreground">
                      For GitHub Actions or any pipeline. It can deploy this app
                      and nothing else, and is shown once.
                    </span>
                  </span>
                </label>
              </CardContent>
            </>
          )}

          {step === 'review' && (
            <>
              <CardHeader>
                <CardTitle>Review</CardTitle>
                <CardDescription>
                  Check the details, then create the app.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <dl className="divide-y rounded-md border text-sm">
                  {(
                    [
                      [
                        'basics',
                        'Name',
                        <span key="n" className="font-mono">
                          {state.name}
                        </span>,
                      ],
                      ['basics', 'Collection', groupName ?? 'None'],
                      [
                        'runtime',
                        'Storage',
                        state.persistent
                          ? 'Keeps data (one instance)'
                          : 'Stateless',
                      ],
                      [
                        'runtime',
                        'Container port',
                        <span key="p" className="font-mono">
                          {state.port}
                        </span>,
                      ],
                      [
                        'runtime',
                        'Default address',
                        state.defaultSubdomain ? (
                          <span key="d" className="font-mono">
                            {state.name}.{rootDomain || 'your-domain'}
                          </span>
                        ) : (
                          'None'
                        ),
                      ],
                      ...(state.domain
                        ? ([
                            [
                              'basics',
                              'Domain',
                              <span key="dom" className="font-mono">
                                {state.domain}
                              </span>,
                            ],
                          ] as [WizardStepId, string, React.ReactNode][])
                        : []),
                      [
                        'deploy',
                        'Deploy',
                        state.deployNow ? (
                          <span key="i" className="font-mono">
                            {state.image.trim()}
                          </span>
                        ) : (
                          'Later'
                        ),
                      ],
                      [
                        'deploy',
                        'CI deploy key',
                        state.ciKey ? 'Create one' : 'No',
                      ],
                    ] as [WizardStepId, string, React.ReactNode][]
                  ).map(([target, label, value]) => (
                    <div
                      key={label}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <dt className="w-32 shrink-0 text-muted-foreground">
                        {label}
                      </dt>
                      <dd className="min-w-0 flex-1 truncate">{value}</dd>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => go(target)}
                      >
                        Edit
                      </button>
                    </div>
                  ))}
                </dl>
                {state.persistent && (
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Whether an app keeps data is fixed when it is created.
                  </p>
                )}
              </CardContent>
            </>
          )}

          <div className="flex flex-col gap-3 border-t p-4">
            {(error || (step !== 'review' && problem && state.name)) &&
              error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                disabled={index === 0 || pending}
                onClick={() => go(WIZARD_STEPS[index - 1].id)}
              >
                Back
              </Button>
              {step === 'review' ? (
                <Button type="submit" disabled={pending}>
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4" />
                  )}
                  {pending
                    ? 'Creating, this takes a few seconds…'
                    : 'Create app'}
                </Button>
              ) : (
                <Button type="submit" disabled={!!problem}>
                  Continue
                </Button>
              )}
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
}

/**
 * Follows the deploy that the wizard just started. Closing the window only stops watching: the deploy runs on the
 * server either way.
 */
function DeployProgress({ app }: { app: string }) {
  const router = useRouter();
  const logRef = useRef<HTMLPreElement>(null);
  const refreshed = useRef(false);
  const status = useQuery({
    queryKey: ['build', app],
    queryFn: () => apiGet<BuildStatus>(`deployment/${app}`),
    // Keep asking until the API reports a finished deploy (it may need a moment to start following it)
    refetchInterval: (q) => {
      const d = q.state.data;
      const phase = deployPhase(
        d && {
          isAppBuilding: d.isAppBuilding,
          isBuildFailed: d.isBuildFailed,
          lines: d.logs.lines,
        },
      );
      return phase === 'done' || phase === 'failed' ? false : 1500;
    },
  });

  const lines = status.data?.logs.lines ?? [];
  const phase = deployPhase(
    status.data && {
      isAppBuilding: status.data.isAppBuilding,
      isBuildFailed: status.data.isBuildFailed,
      lines,
    },
  );
  const finished = phase === 'done' || phase === 'failed';
  const failed = phase === 'failed';

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines.length]);

  useEffect(() => {
    // The list behind the window shows the new state once the deploy has settled
    if (finished && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [finished, router]);

  if (failed) return <DeployFailure lines={lines} />;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      aria-live="polite"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {!finished ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Deploying…
          </>
        ) : failed ? (
          <>
            <XCircle className="h-4 w-4 text-destructive" /> The deploy did not
            succeed
          </>
        ) : (
          <>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Deployed and
            running
          </>
        )}
      </p>
      <pre
        ref={logRef}
        className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs leading-relaxed"
      >
        {lines.length > 0
          ? lines.join('\n')
          : 'Waiting for the deploy to start…'}
      </pre>
      {!finished && (
        <p className="text-xs text-muted-foreground">
          You can close this window: the deploy keeps running in the background.
        </p>
      )}
    </div>
  );
}

function Done({
  state,
  result,
  rootDomain,
  onAnother,
  onClose,
}: {
  onClose: () => void;
  state: WizardState;
  result: WizardResult;
  /** The domain apps are served under: a custom domain's CNAME points at <name>.<this> */
  rootDomain: string;
  onAnother: () => void;
}) {
  const failed = result.steps.filter((s) => s.status === 'failed');
  const deploying = result.steps.some(
    (s) => s.id === 'deploy' && s.status === 'done',
  );
  const open = `/apps/${state.name}`;
  return (
    <Card className="border-0 bg-transparent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {failed.length === 0 ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          )}
          {state.name} is created
        </CardTitle>
        <CardDescription>
          {failed.length === 0
            ? deploying
              ? 'The app is ready. Its first deploy is running.'
              : 'Deploy it from its Deploy tab, or from CI.'
            : 'The app exists, but some steps did not finish. Nothing was rolled back, you can finish them from the app.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="divide-y rounded-md border text-sm">
          {result.steps
            .filter((s) => s.status !== 'skipped')
            .map((s) => (
              <li key={s.id} className="flex items-start gap-2 px-3 py-2">
                {s.status === 'done' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <span>
                  {STEP_LABEL[s.id]}
                  {s.error && (
                    <span className="block text-xs text-destructive">
                      {s.error}
                    </span>
                  )}
                </span>
              </li>
            ))}
        </ul>

        {result.steps.some((s) => s.id === 'domain' && s.status === 'done') &&
          state.domain &&
          (() => {
            const target = `${state.name}.${rootDomain || 'your-domain'}`;
            const [rec] = dnsRecordsFor({
              host: state.domain,
              target,
              addresses: [],
            }).primary;
            return (
              <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                <p>
                  <span className="font-mono">{state.domain}</span> is attached.
                  At your DNS provider, create:
                </p>
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 break-all font-mono text-xs">
                    {rec.type} {rec.name} →{' '}
                    {rec.type === 'CNAME' ? rec.value : 'this server’s address'}
                  </p>
                  {rec.type === 'CNAME' && (
                    <CopyButton value={rec.value} label="Copy target" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Then open the app’s Networking page: it checks DNS as you
                  wait, turns on HTTPS when it is right, and lets you retry the
                  certificate if it does not issue.{' '}
                  <Link
                    href={`${open}/networking#domains`}
                    className="underline underline-offset-2"
                  >
                    Check DNS now
                  </Link>
                </p>
              </div>
            );
          })()}

        {deploying && <DeployProgress app={state.name} />}

        {result.ciKey && (
          <div className="flex flex-col gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            <p className="font-medium">
              Copy the CI key now, it is shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">
                {result.ciKey}
              </code>
              <CopyButton value={result.ciKey} />
            </div>
            <p className="text-xs text-muted-foreground">
              Add it to your repository secrets, then see Settings → API keys
              for a ready-made workflow step.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={open}>Open app</Link>
          </Button>
          <Button variant="outline" onClick={onAnother}>
            Create another
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
