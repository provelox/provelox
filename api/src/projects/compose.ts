import { PLATFORM_HOST_PORTS } from '../apps/app.model';
import { parseDocument } from 'yaml';
import { appDefinition, type AppDefinition } from '../apps/app.model';
import { explainName } from '../common/naming';
import { interpolate } from './interpolate';

export interface PlanIssue {
  /** Compose service the issue is about, when there is one */
  service?: string;
  message: string;
}

export interface ComposePlan {
  project: string;
  /** In the order they must start (dependencies first) */
  apps: AppDefinition[];
  /** Named volumes the project owns */
  volumes: string[];
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export const MAX_COMPOSE_BYTES = 256 * 1024;

/** Refused because they would give a service more power over the host than a plain app has. */
const REFUSED: Record<string, string> = {
  build:
    'Building images is not supported. Push the image to a registry and reference it with "image".',
  privileged: 'Privileged containers are not allowed.',
  cap_add: 'Adding Linux capabilities is not allowed.',
  devices: 'Mapping host devices is not allowed.',
  network_mode:
    'network_mode is not supported: every service joins the project network.',
  pid: 'Sharing the host PID namespace is not allowed.',
  ipc: 'Sharing the IPC namespace is not allowed.',
  userns_mode: 'userns_mode is not supported.',
  security_opt: 'security_opt is not supported.',
  sysctls: 'sysctls are not supported.',
  extends: '"extends" is not supported. Write the full service.',
  profiles:
    '"profiles" is not supported. Remove the services you do not want to run.',
  env_file:
    'env_file needs files this service cannot read. Put the values under "environment".',
  external_links: 'external_links is not supported.',
  secrets: 'Compose secrets are not supported yet.',
  configs: 'Compose configs are not supported yet.',
  tmpfs: 'tmpfs mounts are not supported yet.',
};

/** Accepted but without effect here; the user is told so. */
const IGNORED_WITH_WARNING = [
  'container_name',
  'hostname',
  'domainname',
  'links',
  'extra_hosts',
  'dns',
  'dns_search',
  'logging',
  'stdin_open',
  'tty',
  'cap_drop',
  'ulimits',
  'platform',
  'pull_policy',
  'init',
  'stop_signal',
  'stop_grace_period',
  'mem_limit',
  'cpus',
  'shm_size',
  'read_only',
  'expose',
];

const SUPPORTED = new Set([
  'image',
  'environment',
  'command',
  'entrypoint',
  'ports',
  'volumes',
  'restart',
  'deploy',
  'healthcheck',
  'depends_on',
  'networks',
  'labels',
  'working_dir',
  'user',
  'annotations',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Splits a command line like a shell would for the simple cases ("a b 'c d'"). A `${...}` reference stays in one piece,
 * whatever is inside it (`${X:-a b}`), so a line can be split before its variables are filled in.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  let braces = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (braces > 0) {
      cur += ch;
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
    } else if (ch === '$' && line[i + 1] === '{') {
      cur += '${';
      i++;
      braces = 1;
      started = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else cur += ch;
  }
  if (started || cur) out.push(cur);
  return out;
}

/**
 * A `command` or `entrypoint` written as one string is split into words BEFORE variables are filled in. Filling them in
 * first would let a value with a space (a password, say) turn into two words.
 */
function splitCommandsFirst(parsed: unknown) {
  if (!isRecord(parsed) || !isRecord(parsed.services)) return;
  for (const svc of Object.values(parsed.services))
    if (isRecord(svc))
      for (const key of ['command', 'entrypoint'] as const)
        if (typeof svc[key] === 'string') svc[key] = splitCommand(svc[key]);
}

/** "30s", "1m30s", "500ms", "2h" to seconds. Null when it does not look like a duration. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v) return null;
  const re = /(\d+(?:\.\d+)?)(ms|us|ns|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]);
    total +=
      m[2] === 'h'
        ? n * 3600
        : m[2] === 'm'
          ? n * 60
          : m[2] === 's'
            ? n
            : m[2] === 'ms'
              ? n / 1000
              : 0;
    consumed += m[0].length;
  }
  return consumed === v.length ? total : null;
}

/** "512m", "1g", "1.5GB", 1048576 to bytes. */
export function parseBytes(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(v.trim());
  if (!m) return null;
  const pow = { '': 0, k: 1, m: 2, g: 3, t: 4 }[
    m[2].toLowerCase() as '' | 'k' | 'm' | 'g' | 't'
  ];
  return Math.round(Number(m[1]) * 1024 ** pow);
}

/**
 * `x-provelox` is how a compose file says what plain Compose cannot: that a service should be reachable from the
 * internet (on <project>-<service>.<root domain>) and which container port the proxy should send traffic to.
 * Without it a service is only reachable by the others in its project.
 */
function parseProvelox(raw: unknown, svc: string, c: Collector) {
  const out: { expose: boolean; port?: number } = { expose: false };
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    c.error('"x-provelox" must be a map.', svc);
    return out;
  }
  for (const key of Object.keys(raw))
    if (key !== 'expose' && key !== 'port')
      c.warn(`Unknown key "x-provelox.${key}" is ignored.`, svc);
  if (raw.expose !== undefined) {
    if (typeof raw.expose !== 'boolean')
      c.error('"x-provelox.expose" must be true or false.', svc);
    else out.expose = raw.expose;
  }
  if (raw.port !== undefined) {
    const n = Number(raw.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      c.error('"x-provelox.port" must be a port number.', svc);
    else out.port = n;
  }
  return out;
}

interface VariableDeclaration {
  label?: string;
  description?: string;
  default?: string;
  secret: boolean;
  minLength?: number;
}

const DECLARATION_KEYS = new Set([
  'label',
  'description',
  'default',
  'secret',
  'kind',
  'minLength',
]);

/**
 * The file's own description of the variables it asks for, under the top-level `x-provelox.variables`: which are
 * secrets and how long a value must be. Plain Compose ignores it. Read before variables are filled in, and a value
 * that does not meet its declaration is an error, so the app is never started with a key it will refuse.
 */
function readVariableDeclarations(
  raw: unknown,
  vars: Record<string, string>,
  c: Collector,
): Record<string, VariableDeclaration> {
  const out: Record<string, VariableDeclaration> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    c.error('"x-provelox" at the top of the file must be a map.');
    return out;
  }
  for (const key of Object.keys(raw))
    if (key !== 'variables')
      c.warn(`Unknown key "x-provelox.${key}" is ignored.`);
  if (raw.variables === undefined) return out;
  if (!isRecord(raw.variables)) {
    c.error('"x-provelox.variables" must be a map of variable names.');
    return out;
  }
  for (const [name, d] of Object.entries(raw.variables)) {
    if (!isRecord(d)) {
      c.error(`"x-provelox.variables.${name}" must be a map.`);
      continue;
    }
    for (const key of Object.keys(d))
      if (!DECLARATION_KEYS.has(key))
        c.warn(`Unknown key "x-provelox.variables.${name}.${key}" is ignored.`);
    const text = (k: string) =>
      typeof d[k] === 'string' ? (d[k] as string) : undefined;
    const decl: VariableDeclaration = {
      label: text('label'),
      description: text('description'),
      default: text('default'),
      secret: d.secret === true || d.kind === 'secret',
    };
    if (d.minLength !== undefined) {
      const n = d.minLength;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 256)
        c.error(
          `"x-provelox.variables.${name}.minLength" must be a whole number from 1 to 256.`,
        );
      else decl.minLength = n;
    }
    out[name] = decl;
    const value = vars[name];
    if (decl.minLength && value && value.length < decl.minLength)
      c.error(
        `${name} must be at least ${decl.minLength} characters (it is ${value.length}).`,
      );
  }
  return out;
}

class Collector {
  errors: PlanIssue[] = [];
  warnings: PlanIssue[] = [];
  error(message: string, service?: string) {
    this.errors.push({ service, message });
  }
  warn(message: string, service?: string) {
    this.warnings.push({ service, message });
  }
}

/** Resolves ${VAR} references in every string value of the document, reporting problems once each. */
function interpolateTree(
  node: unknown,
  vars: Record<string, string>,
  c: Collector,
  seen = new Set<string>(),
): unknown {
  if (typeof node === 'string') {
    const r = interpolate(node, vars);
    for (const e of r.errors)
      if (!seen.has(`e:${e}`) && seen.add(`e:${e}`)) c.error(`Variable: ${e}`);
    for (const u of r.unset)
      if (!seen.has(`u:${u}`) && seen.add(`u:${u}`))
        c.warn(`Variable ${u} is not set, using an empty value.`);
    return r.value;
  }
  if (Array.isArray(node))
    return node.map((n) => interpolateTree(n, vars, c, seen));
  if (isRecord(node))
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        interpolateTree(v, vars, c, seen),
      ]),
    );
  return node;
}

interface Draft {
  name: string;
  alias: string;
  deps: string[];
  app: Record<string, unknown>;
}

function parsePorts(raw: unknown, svc: string, c: Collector) {
  const ports: {
    containerPort: number;
    hostPort: number;
    protocol: 'tcp' | 'udp';
  }[] = [];
  let internal: number | undefined;
  if (raw === undefined) return { ports, internal };
  if (!Array.isArray(raw)) {
    c.error('"ports" must be a list.', svc);
    return { ports, internal };
  }
  for (const p of raw) {
    let host: string | undefined;
    let container: string | undefined;
    let protocol: 'tcp' | 'udp' = 'tcp';
    let address: string | undefined;
    if (isRecord(p)) {
      container = p.target !== undefined ? String(p.target) : undefined;
      host = p.published !== undefined ? String(p.published) : undefined;
      protocol = p.protocol === 'udp' ? 'udp' : 'tcp';
      address = typeof p.host_ip === 'string' ? p.host_ip : undefined;
    } else {
      const [spec, proto] = String(p).split('/');
      if (proto === 'udp') protocol = 'udp';
      const parts = spec.split(':');
      if (parts.length === 1) container = parts[0];
      else if (parts.length === 2) [host, container] = parts;
      else {
        address = parts[0];
        [host, container] = parts.slice(1);
      }
    }
    if (!container || /[-]/.test(container) || (host && /[-]/.test(host))) {
      c.error(
        `Port "${JSON.stringify(p)}" is not supported (ranges are not allowed).`,
        svc,
      );
      continue;
    }
    if (address && address !== '0.0.0.0') {
      c.error(
        `Port "${JSON.stringify(p)}" binds to ${address}. Ports are published on all interfaces, so this is not supported. Remove the address, or do not publish the port.`,
        svc,
      );
      continue;
    }
    const containerPort = Number(container);
    if (
      !Number.isInteger(containerPort) ||
      containerPort < 1 ||
      containerPort > 65535
    ) {
      c.error(`"${container}" is not a valid port.`, svc);
      continue;
    }
    if (!host) {
      internal ??= containerPort;
      continue;
    }
    const hostPort = Number(host);
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      c.error(`"${host}" is not a valid port.`, svc);
      continue;
    }
    if (PLATFORM_HOST_PORTS.includes(hostPort)) {
      c.error(
        `Host port ${hostPort} is used by the server and the platform itself, so it cannot be published.`,
        svc,
      );
      continue;
    }
    ports.push({ containerPort, hostPort, protocol });
  }
  return { ports, internal };
}

function parseVolumes(
  raw: unknown,
  svc: string,
  declared: Set<string>,
  c: Collector,
) {
  const volumes: {
    containerPath: string;
    volumeName: string;
    readOnly: boolean;
  }[] = [];
  if (raw === undefined) return volumes;
  if (!Array.isArray(raw)) {
    c.error('"volumes" must be a list.', svc);
    return volumes;
  }
  for (const v of raw) {
    let source: string | undefined;
    let target: string | undefined;
    let readOnly = false;
    let type: string | undefined;
    if (isRecord(v)) {
      type = typeof v.type === 'string' ? v.type : undefined;
      source = typeof v.source === 'string' ? v.source : undefined;
      target = typeof v.target === 'string' ? v.target : undefined;
      readOnly = v.read_only === true;
    } else {
      const parts = String(v).split(':');
      if (parts.length === 1) target = parts[0];
      else {
        [source, target] = parts;
        readOnly = parts[2]?.split(',').includes('ro') ?? false;
      }
    }
    if (type === 'tmpfs') {
      c.error('tmpfs mounts are not supported yet.', svc);
      continue;
    }
    if (!target) {
      c.error(
        `Volume "${JSON.stringify(v)}" has no path inside the container.`,
        svc,
      );
      continue;
    }
    if (!source) {
      c.warn(
        `Anonymous volume at ${target} is ignored: its data would not be kept. Give it a name to keep it.`,
        svc,
      );
      continue;
    }
    if (type === 'bind' || /^[./~]/.test(source)) {
      c.error(
        `"${source}" is a directory on the server. Host paths are not allowed in Compose files: use a named volume.`,
        svc,
      );
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(source)) {
      c.error(`"${source}" is not a valid volume name.`, svc);
      continue;
    }
    if (!declared.has(source)) {
      c.error(
        `Volume "${source}" is used here but not declared under the top-level "volumes".`,
        svc,
      );
      continue;
    }
    volumes.push({ containerPath: target, volumeName: source, readOnly });
  }
  return volumes;
}

function parseEnvironment(raw: unknown, svc: string, c: Collector) {
  const env: { key: string; value: string }[] = [];
  const add = (key: string, value: unknown) => {
    if (value === null || value === undefined) {
      c.warn(`Variable ${key} has no value, so it is not set.`, svc);
      return;
    }
    env.push({ key, value: String(value) });
  };
  if (raw === undefined) return env;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = String(item);
      const i = s.indexOf('=');
      if (i < 0) add(s, null);
      else add(s.slice(0, i), s.slice(i + 1));
    }
  } else if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) add(k, v);
  else c.error('"environment" must be a map or a list.', svc);
  return env;
}

function parseRestart(v: unknown): 'any' | 'on-failure' | 'none' | undefined {
  if (typeof v !== 'string') return undefined;
  if (v === 'no' || v === 'none') return 'none';
  if (v === 'always' || v === 'unless-stopped' || v === 'any') return 'any';
  if (v.startsWith('on-failure')) return 'on-failure';
  return undefined;
}

function parseHealthcheck(raw: unknown, svc: string, c: Collector) {
  if (!isRecord(raw)) return undefined;
  const t = raw.test;
  let test: string[] | undefined;
  if (typeof t === 'string') test = ['CMD-SHELL', t];
  else if (Array.isArray(t)) test = t.map(String);
  if (raw.disable === true || test?.[0] === 'NONE') return undefined;
  if (!test || test.length === 0) return undefined;
  const dur = (key: string) => {
    if (raw[key] === undefined) return undefined;
    const s = parseDuration(raw[key]);
    if (s === null)
      c.warn(
        `healthcheck.${key} "${String(raw[key])}" is not a valid duration and is ignored.`,
        svc,
      );
    return s ?? undefined;
  };
  return {
    test,
    intervalSeconds: dur('interval'),
    timeoutSeconds: dur('timeout'),
    startPeriodSeconds: dur('start_period'),
    retries: typeof raw.retries === 'number' ? raw.retries : undefined,
  };
}

/** Start order: dependencies first, otherwise the order of the file. Null if there is a cycle. */
function startOrder(drafts: Draft[]): string[] | null {
  const byName = new Map(drafts.map((d) => [d.name, d]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];
  const visit = (name: string): boolean => {
    if (done.has(name)) return true;
    if (visiting.has(name)) return false;
    visiting.add(name);
    for (const dep of byName.get(name)?.deps ?? [])
      if (!visit(dep)) return false;
    visiting.delete(name);
    done.add(name);
    out.push(name);
    return true;
  };
  for (const d of drafts) if (!visit(d.name)) return null;
  return out;
}

/**
 * Turns a Compose file into the apps a project is made of. Never throws on bad input: problems come back as
 * `errors` (the plan must not be deployed) and `warnings` (it can, but something is not as written).
 */
export function planCompose(
  yamlText: string,
  project: string,
  vars: Record<string, string> = {},
  now = new Date().toISOString(),
): ComposePlan {
  const c = new Collector();
  const plan = (
    apps: AppDefinition[] = [],
    volumes: string[] = [],
  ): ComposePlan => ({
    project,
    apps,
    volumes,
    errors: c.errors,
    warnings: c.warnings,
  });

  const nameProblem = explainName(project, 'Project');
  if (nameProblem) c.error(nameProblem);
  if (Buffer.byteLength(yamlText) > MAX_COMPOSE_BYTES) {
    c.error('The compose file is too large (256 KB maximum).');
    return plan();
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    for (const e of doc.errors)
      c.error(`The file is not valid YAML: ${e.message.split('\n')[0]}`);
    return plan();
  }
  let parsed: unknown;
  try {
    parsed = doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    // e.g. a YAML alias bomb: report it like any other bad file
    c.error(
      `The file cannot be read: ${e instanceof Error ? e.message : 'invalid content'}`,
    );
    return plan();
  }
  const declaredVariables = isRecord(parsed) ? parsed['x-provelox'] : undefined;
  splitCommandsFirst(parsed);
  const root = interpolateTree(parsed, vars, c);
  if (
    !isRecord(root) ||
    !isRecord(root.services) ||
    Object.keys(root.services).length === 0
  ) {
    c.error('The file needs a "services" section with at least one service.');
    return plan();
  }

  // Top level
  readVariableDeclarations(declaredVariables, vars, c);
  const declared = new Set<string>();
  if (root.volumes !== undefined) {
    if (!isRecord(root.volumes)) c.error('"volumes" must be a map.');
    else
      for (const [name, def] of Object.entries(root.volumes)) {
        if (isRecord(def) && (def.external === true || isRecord(def.external)))
          c.error(
            `Volume "${name}" is external. External volumes are not supported: let the project create it.`,
          );
        else if (isRecord(def) && def.driver && def.driver !== 'local')
          c.error(
            `Volume "${name}" uses driver "${String(def.driver)}". Only local volumes are supported.`,
          );
        else declared.add(name);
      }
  }
  if (root.networks !== undefined)
    c.warn(
      'Custom networks are ignored: every service joins one network, with its service name as hostname.',
    );
  for (const key of ['secrets', 'configs'])
    if (root[key] !== undefined) c.error(REFUSED[key]);

  const services = root.services as Record<string, unknown>;
  const names = Object.keys(services);
  const drafts: Draft[] = [];

  for (const [svc, raw] of Object.entries(services)) {
    if (!isRecord(raw)) {
      c.error('A service must be a map.', svc);
      continue;
    }
    const appName = `${project}-${svc}`;
    const nameIssue = explainName(appName, 'Service');
    if (nameIssue)
      c.error(
        `${nameIssue} The app is named "${appName}" (project and service name joined).`,
        svc,
      );

    for (const key of Object.keys(raw)) {
      if (SUPPORTED.has(key)) continue;
      if (REFUSED[key]) {
        if (key === 'privileged' && raw[key] !== true) continue;
        if (
          key === 'cap_add' &&
          Array.isArray(raw[key]) &&
          raw[key].length === 0
        )
          continue;
        c.error(REFUSED[key], svc);
      } else if (IGNORED_WITH_WARNING.includes(key))
        c.warn(`"${key}" is ignored.`, svc);
      else if (!key.startsWith('x-'))
        c.warn(`Unknown key "${key}" is ignored.`, svc);
    }

    const image = typeof raw.image === 'string' ? raw.image.trim() : '';
    if (!image && raw.build === undefined)
      c.error('The service needs an "image".', svc);
    else if (/\s/.test(image))
      c.error(
        `The image "${image}" contains a space. Check the variable that sets it for extra pasted text.`,
        svc,
      );

    const { ports, internal } = parsePorts(raw.ports, svc, c);
    const volumes = parseVolumes(raw.volumes, svc, declared, c);
    const deploy = isRecord(raw.deploy) ? raw.deploy : {};
    for (const key of Object.keys(deploy))
      if (!['replicas', 'resources', 'restart_policy'].includes(key))
        c.warn(`"deploy.${key}" is ignored.`, svc);

    let replicas = typeof deploy.replicas === 'number' ? deploy.replicas : 1;
    const persistent = volumes.length > 0;
    if (persistent && replicas > 1) {
      c.warn(
        'A service with volumes runs a single instance; replicas is set to 1.',
        svc,
      );
      replicas = 1;
    }

    const limits =
      isRecord(deploy.resources) && isRecord(deploy.resources.limits)
        ? deploy.resources.limits
        : {};
    const memoryBytes =
      limits.memory !== undefined ? parseBytes(limits.memory) : null;
    const cpus = limits.cpus !== undefined ? Number(limits.cpus) : undefined;
    if (limits.memory !== undefined && memoryBytes === null)
      c.warn(
        `Memory limit "${String(limits.memory)}" is not understood and is ignored.`,
        svc,
      );

    let deps: string[] = [];
    if (Array.isArray(raw.depends_on)) deps = raw.depends_on.map(String);
    else if (isRecord(raw.depends_on)) {
      deps = Object.keys(raw.depends_on);
      for (const [d, v] of Object.entries(raw.depends_on))
        if (isRecord(v) && v.condition === 'service_healthy')
          c.warn(
            `Waiting for "${d}" to be healthy is treated as waiting for it to be running.`,
            svc,
          );
    }
    for (const d of deps)
      if (!names.includes(d))
        c.error(
          `depends_on refers to "${d}", which is not a service in the file.`,
          svc,
        );

    const restart =
      parseRestart(raw.restart) ??
      parseRestart(
        isRecord(deploy.restart_policy)
          ? deploy.restart_policy.condition
          : undefined,
      );
    const command =
      typeof raw.command === 'string'
        ? splitCommand(raw.command)
        : Array.isArray(raw.command)
          ? raw.command.map(String)
          : undefined;
    const entrypoint =
      typeof raw.entrypoint === 'string'
        ? splitCommand(raw.entrypoint)
        : Array.isArray(raw.entrypoint)
          ? raw.entrypoint.map(String)
          : undefined;

    const provelox = parseProvelox(raw['x-provelox'], svc, c);

    drafts.push({
      name: svc,
      alias: svc,
      deps,
      app: {
        name: appName,
        persistent,
        image,
        instanceCount: replicas,
        // Compose publishes ports on the host; reaching a service from the internet is an explicit choice
        // (x-provelox), otherwise it stays private to its project
        exposed: provelox.expose,
        containerPort:
          provelox.port ?? internal ?? ports[0]?.containerPort ?? 80,
        env: parseEnvironment(raw.environment, svc, c),
        ports,
        volumes,
        command,
        entrypoint,
        workingDir:
          typeof raw.working_dir === 'string' ? raw.working_dir : undefined,
        user: raw.user !== undefined ? String(raw.user) : undefined,
        healthcheck: parseHealthcheck(raw.healthcheck, svc, c),
        resources: {
          ...(cpus && Number.isFinite(cpus) ? { cpus } : {}),
          ...(memoryBytes ? { memoryBytes } : {}),
        },
        restart,
        project,
        serviceAlias: svc,
        dependsOn: deps.map((d) => `${project}-${d}`),
        createdAt: now,
      },
    });
  }

  const order = startOrder(drafts);
  if (order === null)
    c.error('The services depend on each other in a circle (depends_on).');
  if (c.errors.length > 0) return plan();

  const byName = new Map(drafts.map((d) => [d.name, d]));
  const apps: AppDefinition[] = [];
  for (const name of order ?? []) {
    const d = byName.get(name) as Draft;
    const res = d.app.resources as Record<string, unknown>;
    if (Object.keys(res).length === 0) delete d.app.resources;
    const parsed = appDefinition.safeParse(d.app);
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        c.error(`${i.path.join('.') || 'service'}: ${i.message}`, name);
      continue;
    }
    apps.push(parsed.data);
  }
  if (c.errors.length > 0) return plan();
  return plan(apps, [...declared]);
}
