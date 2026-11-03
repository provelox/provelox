'use client';

import { Eye, EyeOff, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  problemsWith,
  toForm,
  toPatch,
  type RestartPolicy,
  type RuntimeForm,
  type RuntimeSettings,
} from '@/lib/runtime-settings';
import { describeRuntime } from '@/lib/runtime-settings';
import { useUpdateApp } from '../use-update-app';

const RESTART_LABEL: Record<RestartPolicy, string> = {
  any: 'Always restart',
  'on-failure': 'Restart on failure',
  none: 'Never restart',
};

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 border-t pt-5 first:border-t-0 first:pt-0 lg:grid-cols-[14rem_1fr] lg:gap-8">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

/** How the process runs: what it executes, what it may use, how it restarts and how Docker tells it is healthy. */
export function RuntimeForm({
  appName,
  initial,
}: {
  appName: string;
  initial: RuntimeSettings;
}) {
  const { update, pending } = useUpdateApp(appName);
  const original = toForm(initial);
  const [f, setF] = useState<RuntimeForm>(original);
  // Read-only until asked: these settings restart the app, and a command often carries credentials
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const set = (patch: Partial<RuntimeForm>) =>
    setF((cur) => ({ ...cur, ...patch }));

  const problems = problemsWith(f);
  const invalid = Object.keys(problems).length > 0;
  const dirty =
    JSON.stringify(toPatch(f)) !== JSON.stringify(toPatch(original));

  return (
    <Card>
      <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Process & limits</CardTitle>
          <CardDescription>
            {editing
              ? 'Leave a field empty to use what the image defines. Saving restarts the app with the new settings.'
              : 'How the process runs. Editing restarts the app.'}
          </CardDescription>
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReveal((r) => !r)}
              aria-pressed={reveal}
            >
              {reveal ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              {reveal ? 'Hide commands' : 'Show commands'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {!editing && (
          <div className="flex flex-col gap-5">
            {describeRuntime(initial, reveal).map((g) => (
              <Group key={g.title} title={g.title} description={g.description}>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:col-span-2 sm:grid-cols-2">
                  {g.rows.map((r) => (
                    <div key={r.label} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {r.label}
                      </dt>
                      <dd
                        className={
                          r.value
                            ? 'truncate font-mono text-sm'
                            : 'text-sm text-muted-foreground'
                        }
                        title={r.value || undefined}
                      >
                        {r.value || r.empty}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Group>
            ))}
          </div>
        )}
        {editing && (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid && dirty)
                update(toPatch(f), 'Saved. The app is restarting.');
            }}
          >
            <Group
              title="Process"
              description="What runs in the container. Overrides the image’s own."
            >
              <Field
                id="rt-command"
                label="Command"
                hint="Arguments for the entrypoint, like npm run start."
                error={problems.command}
              >
                <Input
                  id="rt-command"
                  value={f.command}
                  onChange={(e) => set({ command: e.target.value })}
                  className="font-mono"
                  placeholder="Image default"
                  spellCheck={false}
                />
              </Field>
              <Field
                id="rt-entrypoint"
                label="Entrypoint"
                error={problems.entrypoint}
              >
                <Input
                  id="rt-entrypoint"
                  value={f.entrypoint}
                  onChange={(e) => set({ entrypoint: e.target.value })}
                  className="font-mono"
                  placeholder="Image default"
                  spellCheck={false}
                />
              </Field>
              <Field
                id="rt-dir"
                label="Working directory"
                error={problems.workingDir}
              >
                <Input
                  id="rt-dir"
                  value={f.workingDir}
                  onChange={(e) => set({ workingDir: e.target.value })}
                  className="font-mono"
                  placeholder="/app"
                  spellCheck={false}
                />
              </Field>
              <Field
                id="rt-user"
                label="User"
                hint="A user name or id, like 1000."
              >
                <Input
                  id="rt-user"
                  value={f.user}
                  onChange={(e) => set({ user: e.target.value })}
                  className="font-mono"
                  placeholder="Image default"
                  spellCheck={false}
                />
              </Field>
            </Group>

            <Group
              title="Resources"
              description="Hard limits for each instance. Empty means unlimited."
            >
              <Field
                id="rt-cpus"
                label="CPU limit"
                hint="In cores: 0.5 is half a core."
                error={problems.cpus}
              >
                <Input
                  id="rt-cpus"
                  inputMode="decimal"
                  value={f.cpus}
                  onChange={(e) => set({ cpus: e.target.value.trim() })}
                  placeholder="Unlimited"
                  className="font-mono"
                />
              </Field>
              <Field
                id="rt-memory"
                label="Memory limit"
                hint="The app is stopped if it goes over."
                error={problems.memory}
              >
                <div className="flex gap-2">
                  <Input
                    id="rt-memory"
                    inputMode="decimal"
                    value={f.memory}
                    onChange={(e) => set({ memory: e.target.value.trim() })}
                    placeholder="Unlimited"
                    className="font-mono"
                  />
                  <Combobox
                    value={f.memoryUnit}
                    onValueChange={(v) =>
                      set({ memoryUnit: v as RuntimeForm['memoryUnit'] })
                    }
                    className="w-24"
                    aria-label="Memory unit"
                    options={[
                      { value: 'MB', label: 'MB' },
                      { value: 'GB', label: 'GB' },
                    ]}
                  />
                </div>
              </Field>
            </Group>

            <Group
              title="Restart"
              description="What Docker does when the process exits."
            >
              <Field id="rt-restart" label="Restart policy">
                <Combobox
                  value={f.restart}
                  onValueChange={(v) => set({ restart: v as RestartPolicy })}
                  id="rt-restart"
                  options={(Object.keys(RESTART_LABEL) as RestartPolicy[]).map(
                    (k) => ({ value: k, label: RESTART_LABEL[k] }),
                  )}
                />
              </Field>
            </Group>

            <Group
              title="Health check"
              description="A command Docker runs inside the container to tell whether the app is healthy. An unhealthy instance is replaced."
            >
              <label className="flex cursor-pointer items-center gap-3 text-sm sm:col-span-2">
                <Checkbox
                  checked={f.healthOn}
                  onCheckedChange={(c) => set({ healthOn: c === true })}
                />
                <span className="font-medium">Run a health check</span>
              </label>
              {f.healthOn && (
                <>
                  <div className="sm:col-span-2">
                    <Field
                      id="rt-health"
                      label="Check command"
                      hint="Healthy when it exits with 0."
                      error={problems.healthCommand}
                    >
                      <Input
                        id="rt-health"
                        value={f.healthCommand}
                        onChange={(e) => set({ healthCommand: e.target.value })}
                        className="font-mono"
                        placeholder="curl -f http://localhost/health"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                  {(
                    [
                      [
                        'interval',
                        'Interval (seconds)',
                        'How often. Docker’s default is 30.',
                      ],
                      [
                        'timeout',
                        'Timeout (seconds)',
                        'How long one check may take.',
                      ],
                      [
                        'retries',
                        'Retries',
                        'Failures in a row before it is unhealthy.',
                      ],
                      [
                        'startPeriod',
                        'Start period (seconds)',
                        'Failures are ignored while the app starts.',
                      ],
                    ] as const
                  ).map(([k, label, hint]) => (
                    <Field
                      key={k}
                      id={`rt-${k}`}
                      label={label}
                      hint={hint}
                      error={problems[k]}
                    >
                      <Input
                        id={`rt-${k}`}
                        inputMode="numeric"
                        value={f[k]}
                        onChange={(e) => set({ [k]: e.target.value.trim() })}
                        placeholder="Default"
                        className="font-mono"
                      />
                    </Field>
                  ))}
                </>
              )}
            </Group>

            <div className="flex items-center gap-2 border-t pt-4">
              <Button type="submit" disabled={pending || invalid || !dirty}>
                Save and restart
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setF(original);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
