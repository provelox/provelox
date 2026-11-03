/**
 * The process, limits and health settings of an app, as people type them, and the shapes the API wants. Kept apart
 * from the form so the conversions can be tested.
 */

export type RestartPolicy = 'any' | 'on-failure' | 'none';

export interface RuntimeSettings {
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  user?: string;
  restart: RestartPolicy;
  resources?: { cpus?: number; memoryBytes?: number };
  healthcheck?: {
    test: string[];
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  };
}

/** What the form holds: every field as text, so a half-typed value is never lost. */
export interface RuntimeForm {
  command: string;
  entrypoint: string;
  workingDir: string;
  user: string;
  restart: RestartPolicy;
  cpus: string;
  memory: string;
  memoryUnit: 'MB' | 'GB';
  healthOn: boolean;
  healthCommand: string;
  interval: string;
  timeout: string;
  retries: string;
  startPeriod: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** Docker will not run a container with less memory than this. */
export const MIN_MEMORY_BYTES = 6 * MB;

/** Splits a command line into arguments the way a shell would: spaces separate, quotes group, backslash escapes. */
export function splitCommand(text: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length)
        cur += text[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) return null; // an unclosed quote
  if (started) out.push(cur);
  return out;
}

/** The reverse: arguments back into a line that splits to the same arguments. */
export function joinCommand(args: string[]): string {
  return args
    .map((a) =>
      a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a,
    )
    .join(' ');
}

export function memoryToForm(
  bytes?: number,
): Pick<RuntimeForm, 'memory' | 'memoryUnit'> {
  if (!bytes) return { memory: '', memoryUnit: 'MB' };
  if (bytes % GB === 0) return { memory: String(bytes / GB), memoryUnit: 'GB' };
  return {
    memory: String(Math.round((bytes / MB) * 100) / 100),
    memoryUnit: 'MB',
  };
}

/** A health check's test, as the one line people write. */
export function healthCommandToText(test: string[]): string {
  if (test[0] === 'CMD-SHELL') return test.slice(1).join(' ');
  if (test[0] === 'CMD') return joinCommand(test.slice(1));
  return joinCommand(test);
}

export function toForm(s: RuntimeSettings): RuntimeForm {
  const h = s.healthcheck;
  return {
    command: s.command ? joinCommand(s.command) : '',
    entrypoint: s.entrypoint ? joinCommand(s.entrypoint) : '',
    workingDir: s.workingDir ?? '',
    user: s.user ?? '',
    restart: s.restart,
    cpus: s.resources?.cpus ? String(s.resources.cpus) : '',
    ...memoryToForm(s.resources?.memoryBytes),
    healthOn: !!h,
    healthCommand: h ? healthCommandToText(h.test) : '',
    interval: h?.intervalSeconds ? String(h.intervalSeconds) : '',
    timeout: h?.timeoutSeconds ? String(h.timeoutSeconds) : '',
    retries: h?.retries ? String(h.retries) : '',
    startPeriod:
      h?.startPeriodSeconds !== undefined ? String(h.startPeriodSeconds) : '',
  };
}

export type RuntimeProblems = Partial<Record<keyof RuntimeForm, string>>;

const positive = (v: string) => v.trim() !== '' && Number(v) > 0;

export function problemsWith(f: RuntimeForm): RuntimeProblems {
  const p: RuntimeProblems = {};
  if (splitCommand(f.command) === null) p.command = 'Close the quote.';
  if (splitCommand(f.entrypoint) === null) p.entrypoint = 'Close the quote.';
  if (f.workingDir.trim() && !f.workingDir.trim().startsWith('/'))
    p.workingDir = 'Use an absolute path, like /app.';
  if (f.cpus.trim() && !(Number(f.cpus) > 0 && Number(f.cpus) <= 256))
    p.cpus = 'Enter a number of cores above 0, like 0.5 or 2.';
  if (f.memory.trim()) {
    const bytes = Number(f.memory) * (f.memoryUnit === 'GB' ? GB : MB);
    if (!(bytes >= MIN_MEMORY_BYTES) || !Number.isFinite(bytes))
      p.memory = 'Docker needs at least 6 MB.';
  }
  if (f.healthOn) {
    if (!f.healthCommand.trim())
      p.healthCommand = 'Enter the command that checks the app.';
    for (const [k, label] of [
      ['interval', 'seconds'],
      ['timeout', 'seconds'],
      ['retries', 'a whole number'],
    ] as const)
      if (f[k].trim() && !positive(f[k])) p[k] = `Enter ${label} above 0.`;
    if (f.retries.trim() && !Number.isInteger(Number(f.retries)))
      p.retries = 'Enter a whole number.';
    if (f.startPeriod.trim() && !(Number(f.startPeriod) >= 0))
      p.startPeriod = 'Enter seconds, 0 or more.';
  }
  return p;
}

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** What to send. null clears a setting back to the image's own. Call only when `problemsWith` is empty. */
export function toPatch(f: RuntimeForm) {
  const cpus = num(f.cpus);
  const memory = num(f.memory);
  const memoryBytes =
    memory === undefined
      ? undefined
      : Math.round(memory * (f.memoryUnit === 'GB' ? GB : MB));
  const command = splitCommand(f.command) ?? [];
  const entrypoint = splitCommand(f.entrypoint) ?? [];
  return {
    command: command.length ? command : null,
    entrypoint: entrypoint.length ? entrypoint : null,
    workingDir: f.workingDir.trim() || null,
    user: f.user.trim() || null,
    restart: f.restart,
    resources:
      cpus === undefined && memoryBytes === undefined
        ? null
        : {
            ...(cpus !== undefined && { cpus }),
            ...(memoryBytes !== undefined && { memoryBytes }),
          },
    healthcheck: f.healthOn
      ? {
          test: ['CMD-SHELL', f.healthCommand.trim()],
          ...(num(f.interval) !== undefined && {
            intervalSeconds: num(f.interval),
          }),
          ...(num(f.timeout) !== undefined && {
            timeoutSeconds: num(f.timeout),
          }),
          ...(num(f.retries) !== undefined && { retries: num(f.retries) }),
          ...(num(f.startPeriod) !== undefined && {
            startPeriodSeconds: num(f.startPeriod),
          }),
        }
      : null,
  };
}

const RESTART_WORDS: Record<RestartPolicy, string> = {
  any: 'Always',
  'on-failure': 'On failure',
  none: 'Never',
};

const sizeOf = (bytes: number) =>
  bytes % GB === 0
    ? `${bytes / GB} GB`
    : `${Math.round((bytes / MB) * 100) / 100} MB`;

/** One line each, for the app overview: how it restarts, what it may use, and whether it is health checked. */
export function summarizeRuntime(
  s: RuntimeSettings = { restart: 'any' },
): { label: string; value: string }[] {
  const limits = [
    s.resources?.cpus ? `${s.resources.cpus} CPU` : '',
    s.resources?.memoryBytes ? sizeOf(s.resources.memoryBytes) : '',
  ].filter(Boolean);
  return [
    { label: 'Restart', value: RESTART_WORDS[s.restart] },
    { label: 'Limits', value: limits.length ? limits.join(', ') : 'None' },
    { label: 'Health check', value: s.healthcheck ? 'On' : 'Off' },
  ];
}

export interface RuntimeGroup {
  title: string;
  description: string;
  rows: { label: string; value: string; empty: string }[];
}

const HIDDEN = '••••••••';

/**
 * The settings as read-only text, in the same groups as the form. Command lines are hidden unless `reveal`: they
 * often carry credentials (a --requirepass, a connection string), so they are treated like environment values.
 */
export function describeRuntime(
  s: RuntimeSettings,
  reveal: boolean,
): RuntimeGroup[] {
  const shown = (v: string) => (v && !reveal ? HIDDEN : v);
  const form = toForm(s);
  const h = s.healthcheck;
  const every = (label: string, v?: number) => (v ? `${label} ${v}s` : '');
  return [
    {
      title: 'Process',
      description: 'What runs in the container. Overrides the image’s own.',
      rows: [
        {
          label: 'Command',
          value: shown(form.command),
          empty: 'Image default',
        },
        {
          label: 'Entrypoint',
          value: shown(form.entrypoint),
          empty: 'Image default',
        },
        {
          label: 'Working directory',
          value: form.workingDir,
          empty: 'Image default',
        },
        { label: 'User', value: form.user, empty: 'Image default' },
      ],
    },
    {
      title: 'Resources',
      description: 'Hard limits for each instance.',
      rows: [
        {
          label: 'CPU limit',
          value: form.cpus ? `${form.cpus} cores` : '',
          empty: 'Unlimited',
        },
        {
          label: 'Memory limit',
          value: form.memory ? `${form.memory} ${form.memoryUnit}` : '',
          empty: 'Unlimited',
        },
      ],
    },
    {
      title: 'Restart',
      description: 'What Docker does when the process exits.',
      rows: [
        {
          label: 'Restart policy',
          value: RESTART_WORDS[s.restart],
          empty: '',
        },
      ],
    },
    {
      title: 'Health check',
      description: 'A command Docker runs to tell whether the app is healthy.',
      rows: h
        ? [
            {
              label: 'Command',
              value: shown(form.healthCommand),
              empty: '',
            },
            {
              label: 'Timing',
              value:
                [
                  every('every', h.intervalSeconds),
                  every('timeout', h.timeoutSeconds),
                  h.retries ? `${h.retries} retries` : '',
                  h.startPeriodSeconds !== undefined
                    ? `starts after ${h.startPeriodSeconds}s`
                    : '',
                ]
                  .filter(Boolean)
                  .join(', ') || 'Docker defaults',
              empty: '',
            },
          ]
        : [{ label: 'Health check', value: '', empty: 'Off' }],
    },
  ];
}
