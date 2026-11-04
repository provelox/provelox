'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Globe,
  Loader2,
  Rocket,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  deployProjectAction,
  previewProjectAction,
  type DeployedProject,
} from '@/actions/projects';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CodeEditor, formatYaml } from '@/components/code-editor';
import { Input } from '@/components/ui/input';
import { explainAppName } from '@/lib/app-name';
import {
  declaredVariables,
  extractVariables,
  variableServices,
} from '@/lib/compose-vars';
import { keptLines, renamesFrom } from '@/lib/renames';
import type {
  KeptSettings,
  ServiceChange,
  ProjectPlan,
  Template,
} from '@/lib/types';
import { ProjectProgress } from './project-progress';
import {
  secretFor,
  tooShort,
  VariablesForm,
  type VariableField,
} from './variables-form';
import { useHeld } from '@/lib/use-held';

/** What a service keeps that the compose file cannot say: its addresses and the settings made in Networking. */
function KeptList({ keeps }: { keeps: KeptSettings | undefined }) {
  const lines = keptLines(keeps);
  if (lines.length === 0) return null;
  return (
    <ul className="mt-0.5 list-disc pl-4">
      {lines.map((l) => (
        <li key={l} className="break-words">
          Keeps: {l}
        </li>
      ))}
    </ul>
  );
}

export type DeployMode =
  | { kind: 'template'; template: Template; compose: string }
  | {
      kind: 'custom';
      /** Start from this (apps that already run, grouped into a new project) instead of an empty file */
      name?: string;
      compose?: string;
      values?: Record<string, string>;
      notes?: string[];
      adopt?: Record<string, string>;
    }
  | {
      kind: 'update';
      project: string;
      compose: string;
      /** Starting values for the variables, when something was added that needs them */
      values?: Record<string, string>;
      /** What was renamed to avoid clashes, told before the review */
      notes?: string[];
      /** Services that are apps already running, moved into the project: service name to app name */
      adopt?: Record<string, string>;
    };

const SECRET_LIKE = /PASS|SECRET|TOKEN|KEY/i;

function titleOf(mode: DeployMode) {
  return mode.kind === 'template'
    ? `Deploy ${mode.template.name}`
    : mode.kind === 'update'
      ? `Update ${mode.project}`
      : mode.adopt
        ? 'Group apps into a new project'
        : 'New project from a compose file';
}

function Body({
  mode,
  existingProjects,
  onClose,
  onBusy,
  onConfiguring,
}: {
  mode: DeployMode;
  existingProjects: string[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  /** Whether the form is on screen, so the dialog can be tall for it and short for the review */
  onConfiguring: (configuring: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(
    mode.kind === 'template'
      ? (() => {
          // suggest a free name: postgres, postgres-2, ...
          let n = mode.template.id.split(':').pop() as string;
          for (let i = 2; existingProjects.includes(n); i++)
            n = `${mode.template.id.split(':').pop()}-${i}`;
          return n;
        })()
      : mode.kind === 'update'
        ? mode.project
        : (mode.name ?? ''),
  );
  const [compose, setCompose] = useState(
    mode.kind === 'custom' ? (mode.compose ?? '') : mode.compose,
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    mode.kind === 'template'
      ? Object.fromEntries(
          mode.template.variables.map((v) => [
            v.key,
            v.kind === 'secret' ? secretFor(v) : (v.default ?? ''),
          ]),
        )
      : mode.values
        ? mode.values
        : {},
  );
  const [step, setStep] = useState<'configure' | 'review' | 'deploying'>(
    'configure',
  );
  const [plan, setPlan] = useState<ProjectPlan>();
  // Which suggested renames the person has unchecked, by the new service's name. Unanswered counts as accepted.
  const [renameChoice, setRenameChoice] = useState<Record<string, boolean>>({});
  const [deployed, setDeployed] = useState<DeployedProject>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const refreshed = useRef(false);
  useEffect(() => onConfiguring(step === 'configure'), [step, onConfiguring]);

  const detected = useMemo(() => extractVariables(compose), [compose]);
  const declarations = useMemo(() => declaredVariables(compose), [compose]);
  const usedBy = useMemo(() => variableServices(compose), [compose]);
  const fields: VariableField[] = useMemo(() => {
    // What the file declares wins over what can be guessed from the names and the messages
    const guessed = (v: (typeof detected)[number]): VariableField => {
      const d = declarations[v.key];
      return {
        key: v.key,
        label: d?.label ?? v.key,
        kind: (d ? d.secret : SECRET_LIKE.test(v.key)) ? 'secret' : 'text',
        minLength: d?.minLength ?? v.minLength,
        description:
          d?.description ??
          (v.required
            ? 'Required'
            : v.default !== undefined
              ? `Default: ${v.default || '(empty)'}`
              : undefined),
      };
    };
    if (mode.kind !== 'template') return detected.map(guessed);
    // a template describes its variables; one it forgot to describe still gets a field, so nothing deploys empty
    const declared = new Set(mode.template.variables.map((v) => v.key));
    return [
      ...mode.template.variables,
      ...detected.filter((d) => !declared.has(d.key)).map(guessed),
    ];
  }, [mode, detected, declarations]);
  // What the file needs, filled from its own defaults when the user left a box empty
  const send = useMemo(() => {
    const defaults = Object.fromEntries(
      detected
        .filter((d) => d.default !== undefined)
        .map((d) => [d.key, d.default as string]),
    );
    return Object.fromEntries(
      fields.map((f) => [
        f.key,
        values[f.key] === undefined || values[f.key] === ''
          ? (defaults[f.key] ?? '')
          : values[f.key],
      ]),
    );
  }, [fields, values, detected]);

  const update = mode.kind === 'update';
  // Services that are apps already running: they keep their data and address when they move in
  const adopt = mode.kind === 'template' ? undefined : mode.adopt;
  const nameProblem = update
    ? null
    : (explainAppName(name) ??
      (existingProjects.includes(name)
        ? 'A project with that name already exists.'
        : null));
  const missing = detected.filter(
    (d) => d.required && d.default === undefined && !values[d.key],
  );
  const tooShortFields = fields.filter((f) => tooShort(f, values[f.key]));
  const canReview =
    !nameProblem &&
    !!name &&
    compose.trim().length > 0 &&
    missing.length === 0 &&
    tooShortFields.length === 0;

  const run = (work: () => Promise<void>) => {
    onBusy(true);
    startTransition(async () => {
      try {
        await work();
      } finally {
        onBusy(false);
      }
    });
  };

  const review = () =>
    run(async () => {
      setError(undefined);
      const first = await previewProjectAction(name, compose, send, adopt);
      if (!first.ok || !first.data)
        return setError(first.ok ? 'Nothing came back.' : first.error);
      let shown = first.data;
      // A service that looks renamed is carried on by default (the recommended choice), so the review already shows it
      // that way; the person can uncheck it
      const renames = renamesFrom(shown.renameCandidates, renameChoice);
      if (Object.keys(renames).length > 0) {
        const again = await previewProjectAction(
          name,
          compose,
          send,
          adopt,
          renames,
        );
        if (!again.ok || !again.data)
          return setError(again.ok ? 'Nothing came back.' : again.error);
        shown = again.data;
      }
      setPlan(shown);
      setStep('review');
    });

  /** Checking or unchecking a suggested rename shows what the update would do either way */
  const chooseRename = (to: string, keep: boolean) =>
    run(async () => {
      if (!plan) return;
      setError(undefined);
      const choice = { ...renameChoice, [to]: keep };
      const res = await previewProjectAction(
        name,
        compose,
        send,
        adopt,
        renamesFrom(plan.renameCandidates, choice),
      );
      if (!res.ok || !res.data)
        return setError(res.ok ? 'Nothing came back.' : res.error);
      setRenameChoice(choice);
      setPlan(res.data);
    });

  const deploy = () =>
    run(async () => {
      setError(undefined);
      const res = await deployProjectAction(
        name,
        compose,
        send,
        update,
        adopt,
        plan ? renamesFrom(plan.renameCandidates, renameChoice) : {},
      );
      if (!res.ok) return setError(res.error);
      setDeployed(res.data);
      setStep('deploying');
      if (!refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {step === 'configure' && (
        <form
          className="animate-in fade-in-0 duration-200 flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (canReview) review();
          }}
        >
          {/* Everything but the footer scrolls in here when the window is too short for it; the footer never moves */}
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pb-4">
            <div
              className={
                mode.kind === 'template'
                  ? 'flex flex-col gap-4'
                  : 'grid gap-6 lg:h-full lg:min-h-[30rem] lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]'
              }
            >
              <div className="flex min-w-0 flex-col gap-4 lg:min-h-0">
                {mode.kind === 'template' && (
                  <p className="text-sm text-muted-foreground">
                    {mode.template.description}
                  </p>
                )}
                {mode.kind !== 'template' && !!mode.notes?.length && (
                  <ul className="list-disc rounded-md border bg-secondary/30 py-2 pl-7 pr-3 text-xs text-muted-foreground">
                    {mode.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor="project-name" className="text-sm font-medium">
                    Project name
                  </label>
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(e) =>
                      setName(e.target.value.trim().toLowerCase())
                    }
                    readOnly={update}
                    placeholder="e.g. shop"
                    className="max-w-sm font-mono"
                    aria-invalid={!!name && !!nameProblem}
                    autoFocus={mode.kind === 'custom' && !mode.compose}
                  />
                  {name && nameProblem ? (
                    <p role="alert" className="text-xs text-destructive">
                      {nameProblem}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Each service becomes an app named{' '}
                      <code>{name || 'project'}-service</code>, grouped under
                      this name.
                    </p>
                  )}
                </div>

                {mode.kind !== 'template' && (
                  <div className="flex flex-col gap-1 lg:min-h-0 lg:flex-1">
                    <div className="flex items-center justify-between">
                      <label htmlFor="compose" className="text-sm font-medium">
                        Compose file
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Tidy the indentation and spacing. Not available while the YAML has errors."
                        disabled={formatYaml(compose) === null}
                        onClick={() => {
                          const out = formatYaml(compose);
                          if (out !== null) setCompose(out);
                        }}
                      >
                        Format
                      </Button>
                    </div>
                    <CodeEditor
                      id="compose"
                      value={compose}
                      onChange={setCompose}
                      fill
                      placeholder={'services:\n  web:\n    image: nginx:alpine'}
                    />
                    <p className="text-xs text-muted-foreground">
                      Uses <code>image:</code> (images are not built here). Add{' '}
                      <code>x-provelox: {'{ expose: true, port: 80 }'}</code> to
                      a service to make it reachable from the internet;
                      otherwise services are only reachable by each other.
                    </p>
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
                <VariablesForm
                  fields={fields}
                  services={usedBy}
                  values={values}
                  onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
                />
                {update && fields.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {fields.some(
                      (f) =>
                        mode.kind === 'update' && f.key in (mode.values ?? {}),
                    )
                      ? 'Filled in from what the services are running now, so an update that changes nothing restarts nothing. A new variable is empty. Changing a value restarts the service that uses it: the next step lists exactly which.'
                      : 'Values are never stored, so enter them again to update. Services whose settings do not change are not restarted.'}
                  </p>
                )}

                {mode.kind === 'template' && (
                  <details className="rounded-md border text-xs">
                    <summary className="flex cursor-pointer items-center gap-1 px-3 py-2 text-muted-foreground">
                      <ChevronDown className="h-3 w-3" /> See the compose file
                      this deploys
                    </summary>
                    <pre className="max-h-60 overflow-auto border-t bg-muted p-3 font-mono">
                      {mode.compose}
                    </pre>
                  </details>
                )}
              </div>
            </div>

            {missing.length > 0 && (
              <p className="mt-4 text-xs text-muted-foreground">
                Fill in: {missing.map((m) => m.key).join(', ')}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          {/* The last item of the form, flush with the dialog's bottom edge: Review is never lost below a long list */}
          <div className="-mx-6 -mb-6 flex shrink-0 justify-end gap-2 border-t bg-background px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canReview || pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} Review
            </Button>
          </div>
        </form>
      )}

      {step === 'review' && plan && (
        <div className="animate-in fade-in-0 duration-200 flex flex-col gap-4">
          {plan.diff.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {diffSummary(plan.diff)}
            </p>
          )}
          {plan.adopting.length > 0 && (
            <div className="rounded-md border bg-secondary/30 p-3 text-xs">
              <p className="mb-1 text-sm font-medium">
                {plan.adopting.length} running app
                {plan.adopting.length === 1 ? '' : 's'} move
                {plan.adopting.length === 1 ? 's' : ''} into the project
              </p>
              <ul className="flex flex-col gap-1 text-muted-foreground">
                {plan.adopting.map((a) => (
                  <li key={a.app}>
                    <code className="font-mono text-foreground">{a.app}</code>{' '}
                    becomes <code className="font-mono">{a.to}</code>.{' '}
                    {a.gap
                      ? 'It restarts, so it is briefly unavailable: it keeps its data, and it moves last.'
                      : 'It keeps running while the new one starts; nothing is interrupted.'}
                    <KeptList keeps={a.keeps} />
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground">
                Data, addresses and settings stay as they are, and the old name
                still reaches the app from other apps. Addresses, HTTPS and
                sign-in are set in the Networking tab, so they are not in the
                compose file above; they are kept all the same.
              </p>
            </div>
          )}
          {plan.renameCandidates.length > 0 && (
            <div className="rounded-md border bg-secondary/30 p-3 text-xs">
              <p className="mb-1 text-sm font-medium">
                {plan.renameCandidates.length === 1
                  ? 'A service looks renamed'
                  : 'Services look renamed'}
              </p>
              <ul className="flex flex-col gap-3">
                {plan.renameCandidates.map((c) => {
                  const keep = renameChoice[c.to] ?? true;
                  const done = plan.renaming.find((r) => r.to === c.to);
                  return (
                    <li key={c.to}>
                      <label className="flex cursor-pointer items-start gap-2">
                        <Checkbox
                          className="mt-0.5"
                          checked={keep}
                          disabled={pending}
                          onCheckedChange={(on) =>
                            chooseRename(c.to, on === true)
                          }
                        />
                        <span>
                          <code className="font-mono text-foreground">
                            {c.from}
                          </code>{' '}
                          looks renamed to{' '}
                          <code className="font-mono text-foreground">
                            {c.to}
                          </code>
                          : keep its domains, secrets, deploy keys and history{' '}
                          <span className="text-foreground">(recommended)</span>
                          .{' '}
                          <span className="text-muted-foreground">
                            {c.reason}
                          </span>
                        </span>
                      </label>
                      {keep ? (
                        <div className="ml-6 text-muted-foreground">
                          {done?.gap
                            ? 'It keeps data on a volume, so it stops before the new one starts: briefly unavailable. The data stays in the project’s volumes.'
                            : 'The new service starts beside the old one, then the old one goes.'}
                          <KeptList keeps={done?.keeps} />
                        </div>
                      ) : (
                        <p className="ml-6 text-amber-700 dark:text-amber-400">
                          <code className="font-mono">{c.from}</code> is removed
                          with its domains and deploy keys, and{' '}
                          <code className="font-mono">{c.to}</code> starts as a
                          new service with none. Data volumes are kept.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <ul className="divide-y rounded-md border text-sm">
            {plan.services.map((s) => {
              const d = plan.diff.find((x) => x.app === s.app);
              const change = d
                ? d.action
                : plan.changes.create.includes(s.app)
                  ? 'create'
                  : 'update';
              return (
                <li
                  key={s.app}
                  className="flex items-start justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                      {s.service}
                      <Badge variant={BADGE[change].variant}>
                        {BADGE[change].label}
                      </Badge>
                      {s.public && (
                        <Badge>
                          <Globe className="mr-1 h-3 w-3" /> public
                        </Badge>
                      )}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {s.image}
                    </span>
                    {d && d.action !== 'create' && d.reasons.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                        {d.reasons.map((r) => (
                          <li key={r} className="break-words">
                            {r}
                          </li>
                        ))}
                      </ul>
                    )}
                    {d?.action === 'restart' && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {d.briefOutage
                          ? 'It keeps data on a volume, so it stops before the new one starts: briefly unavailable.'
                          : 'The new container starts before the old one stops.'}
                      </span>
                    )}
                    {d && d.secretsChanged.length > 0 && (
                      <span className="mt-1 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          {d.secretsChanged.join(', ')}{' '}
                          {d.secretsChanged.length > 1 ? 'differ' : 'differs'}{' '}
                          from what is running. If you did not mean to change{' '}
                          {d.secretsChanged.length > 1 ? 'them' : 'it'}, go back
                          and check the value.
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.volumes > 0 &&
                      `${s.volumes} volume${s.volumes > 1 ? 's' : ''}`}
                  </span>
                </li>
              );
            })}
            {plan.changes.remove.map((r) => (
              <li
                key={r}
                className="flex items-center justify-between px-3 py-2 text-sm text-destructive"
              >
                <span className="font-mono text-xs">{r}</span>
                <Badge variant="destructive">removed</Badge>
              </li>
            ))}
          </ul>
          {plan.changes.remove.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Services no longer in the file are removed. Their data volumes are
              kept.
            </p>
          )}
          {plan.errors.map((e, i) => (
            <p
              key={i}
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {e.service && <strong>{e.service}: </strong>}
                {e.message}
              </span>
            </p>
          ))}
          {plan.warnings.map((w, i) => (
            <p
              key={i}
              className="flex items-start gap-2 text-xs text-muted-foreground"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>
                {w.service && <strong>{w.service}: </strong>}
                {w.message}
              </span>
            </p>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep('configure')}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              onClick={deploy}
              disabled={pending || plan.errors.length > 0}
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              {pending
                ? 'Deploying: pulling images and starting services…'
                : update
                  ? 'Update project'
                  : 'Deploy'}
            </Button>
          </div>
          {pending && <ProjectProgress project={name} />}
        </div>
      )}

      {step === 'deploying' && deployed && (
        <div className="animate-in fade-in-0 duration-200 flex flex-col gap-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" /> {name}{' '}
            {update ? 'is updated' : 'is created'}
          </p>
          <ProjectProgress project={name} />
          {deployed.warnings.map((w, i) => (
            <p
              key={i}
              className="flex items-start gap-2 text-xs text-muted-foreground"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>
                {w.service && <strong>{w.service}: </strong>}
                {w.message}
              </span>
            </p>
          ))}
          {mode.kind === 'template' && mode.template.port && (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              Other apps connect to{' '}
              <code className="font-mono">
                {name}-{mode.template.mainService}
              </code>{' '}
              on port <code className="font-mono">{mode.template.port}</code>.
            </p>
          )}
          <div className="flex gap-2">
            <Button asChild>
              {/* Already on this project: the link goes nowhere, so close the dialog too. */}
              <Link href={`/projects/${name}`} onClick={onClose}>
                Open project
              </Link>
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const BADGE: Record<
  ServiceChange['action'],
  { label: string; variant: 'success' | 'default' | 'warning' | 'destructive' }
> = {
  create: { label: 'new', variant: 'success' },
  unchanged: { label: 'unchanged', variant: 'default' },
  update: { label: 'update', variant: 'default' },
  restart: { label: 'restarts', variant: 'warning' },
  remove: { label: 'removed', variant: 'destructive' },
};

/** "2 restart, 1 new, 3 stay as they are": what the update does, before the details */
function diffSummary(diff: ServiceChange[]) {
  const n = (a: ServiceChange['action']) =>
    diff.filter((d) => d.action === a).length;
  const parts = [
    n('restart') && `${n('restart')} restart`,
    n('create') && `${n('create')} new`,
    n('update') && `${n('update')} change without restarting`,
    n('remove') && `${n('remove')} removed`,
    n('unchanged') && `${n('unchanged')} stay as they are`,
  ].filter(Boolean);
  return parts.join(', ');
}

/** The one dialog for putting a compose project on the platform: from a template, a pasted file, or an update. */
export function DeployProjectDialog({
  mode: current,
  existingProjects,
  onClose,
}: {
  mode: DeployMode | null;
  existingProjects: string[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [configuring, setConfiguring] = useState(true);
  // what the dialog shows stays put while it fades out, instead of emptying and resizing as `mode` clears
  const mode = useHeld(current);
  return (
    <Dialog open={!!current} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className={`max-h-[92vh] ${configuring ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'} ${mode?.kind === 'template' ? 'sm:max-w-2xl' : `sm:max-w-5xl ${configuring ? 'lg:h-[92vh]' : ''}`}`}
        // a stray click outside must not throw away what has been typed
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{mode ? titleOf(mode) : ''}</DialogTitle>
          <DialogDescription>
            {mode?.kind === 'update'
              ? 'Review what changes before anything is touched.'
              : 'You review what will be created before anything is deployed.'}
          </DialogDescription>
        </DialogHeader>
        {mode && (
          <Body
            key={
              mode.kind +
              (mode.kind === 'template'
                ? mode.template.id
                : mode.kind === 'update'
                  ? String(mode.compose.length)
                  : String(mode.compose?.length ?? ''))
            }
            mode={mode}
            existingProjects={existingProjects}
            onClose={onClose}
            onBusy={setBusy}
            onConfiguring={setConfiguring}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
