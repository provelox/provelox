import { parseDocument } from 'yaml';
import { splitCommand } from '../projects/compose';
import { TEMPLATES, type Template } from './catalog';

/** The template a project was deployed from, when its compose file is still exactly that template's. */
export function templateOfProject(
  compose: string,
  extra: Template[] = [],
): Template | null {
  const norm = (c: string) => c.trim().replace(/\r\n/g, '\n');
  return (
    [...TEMPLATES, ...extra].find((t) => norm(t.compose) === norm(compose)) ??
    null
  );
}

/** What the deployed services of the project hold, by app name: the parts a variable's value can be read back from. */
export interface DeployedApp {
  name: string;
  /** The image it runs, as deployed */
  image?: string;
  env: { key: string; value: string }[];
  command?: string[];
}

export interface ResolvedVariable {
  key: string;
  label: string;
  description?: string;
  kind: 'text' | 'secret';
  /** What it was set to, read back from the running service. Null when it cannot be found. */
  value: string | null;
  /** Where it lives on the service, for the person to find it again: "environment variable X", "its command" */
  where: string | null;
}

const exactly = (raw: unknown, key: string) => {
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  // $KEY, ${KEY}, ${KEY:-fallback}, ${KEY-fallback}, ${KEY:?message}, ${KEY?message}: the whole value is the variable
  return (
    t === `$${key}` || new RegExp(`^\\$\\{${key}(:?[-?][^}]*)?\\}$`).test(t)
  );
};

/**
 * Reads each variable's value back from the services it was given to. Variables are substituted into the compose
 * file when it is deployed and are not stored apart, but they end up in a service's environment or command, so the
 * compose file says where to look: `NAME: ${VAR}` in `environment`, or a `${VAR}` word in `command`.
 */
export function resolveVariables(
  t: Template,
  project: string,
  apps: DeployedApp[],
): ResolvedVariable[] {
  return readBack(t.compose, t.variables, project, apps);
}

/** The same for any compose file, with the variables it asks for: the ones its services can say a value for. */
export function readBack(
  compose: string,
  variables: Pick<ResolvedVariable, 'key' | 'label' | 'description' | 'kind'>[],
  project: string,
  apps: DeployedApp[],
): ResolvedVariable[] {
  const doc = parseDocument(compose).toJS() as {
    services?: Record<
      string,
      { image?: unknown; environment?: unknown; command?: unknown }
    >;
  };
  const appOf = (service: string) =>
    apps.find((a) => a.name === `${project}-${service}`);

  return variables.map((v) => {
    const base = {
      key: v.key,
      label: v.label,
      description: v.description,
      kind: v.kind,
      value: null as string | null,
      where: null as string | null,
    };
    for (const [service, def] of Object.entries(doc.services ?? {})) {
      const app = appOf(service);
      if (!app) continue;

      // the image: `image: ${API_IMAGE}`
      if (exactly(def.image, v.key) && app.image)
        return { ...base, value: app.image, where: 'its image' };

      // environment, as a map or as a list of NAME=value
      const env = def.environment;
      const pairs: [string, unknown][] = Array.isArray(env)
        ? env.map((e) => {
            const [k, ...rest] = String(e).split('=');
            return [k, rest.join('=')] as [string, unknown];
          })
        : env && typeof env === 'object'
          ? Object.entries(env as Record<string, unknown>)
          : [];
      for (const [name, raw] of pairs) {
        if (!exactly(raw, v.key)) continue;
        const actual = app.env.find((e) => e.key === name)?.value;
        if (actual !== undefined)
          return {
            ...base,
            value: actual,
            where: `the environment variable ${name}`,
          };
      }

      // a word of the command: the same position in the command the service runs
      const words =
        typeof def.command === 'string'
          ? splitCommand(def.command)
          : Array.isArray(def.command)
            ? def.command.map(String)
            : [];
      const at = words.findIndex((w) => exactly(w, v.key));
      if (at >= 0 && app.command?.[at] !== undefined)
        return { ...base, value: app.command[at], where: 'its command' };
    }
    return base;
  });
}

export interface Connection {
  /** How another app on this server reaches the main service */
  host: string;
  /** How the project's own services reach it: the compose service name */
  hostInProject: string;
  port: number | null;
  /** The connection string with every value filled in. Null when the template has none or a value is unknown. */
  url: string | null;
  /** The same, with an unknown value shown as its name, for a person to see what is still needed */
  urlTemplate: string | null;
}

/** How to reach a template's main service, from other apps and from inside the project. */
export function connectionOf(
  t: Template,
  project: string,
  variables: ResolvedVariable[],
): Connection {
  const host = `${project}-${t.mainService}`;
  const fill = (pattern: string, unknown: (key: string) => string) =>
    pattern.replace(/\{(\w+)\}/g, (_m, name: string) => {
      if (name === 'host') return host;
      if (name === 'port') return String(t.port ?? '');
      const v = variables.find((x) => x.key === name);
      // a value inside a URL has to be encoded: a password may hold @ or /
      return v?.value != null ? encodeURIComponent(v.value) : unknown(name);
    });
  const missing = t.connect
    ? [...t.connect.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .filter(
          (n) =>
            n !== 'host' &&
            n !== 'port' &&
            variables.find((x) => x.key === n)?.value == null,
        )
    : [];
  return {
    host,
    hostInProject: t.mainService,
    port: t.port ?? null,
    url: t.connect && missing.length === 0 ? fill(t.connect, () => '') : null,
    urlTemplate: t.connect ? fill(t.connect, (n) => `<${n}>`) : null,
  };
}
