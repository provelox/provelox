import { randomBytes } from 'node:crypto';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ValidationError } from '../common/errors';
import type { Template } from '../templates/catalog';

/**
 * Adding to a project that exists: the project is its compose file, so adding a service (or a whole template) is a new
 * compose file. These make it, keeping the rest of the file as it was (comments and all), and renaming what would clash
 * with something already there. They deploy nothing: the result goes through the same review as any other edit.
 */
export interface MergeResult {
  compose: string;
  /** What to start the variables the new file needs at: generated secrets, defaults, what was typed */
  values: Record<string, string>;
  /** Services that were added, as named in the file */
  services: string[];
  /** What had to be renamed to avoid a clash, so the person is told */
  renamed: {
    kind: 'service' | 'volume' | 'variable';
    from: string;
    to: string;
  }[];
}

// A dollar that follows another is the second half of an escaped "$$", never the start of a reference
const REF =
  /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** The variables a compose text refers to, with the default it gives for each, if any. */
function variablesIn(text: string) {
  const found = new Map<string, string | undefined>();
  for (const m of text.matchAll(REF)) {
    const key = (m[1] ?? m[4]) as string;
    const dflt = m[2] === ':-' || m[2] === '-' ? (m[3] ?? '') : undefined;
    if (!found.has(key) || (found.get(key) === undefined && dflt !== undefined))
      found.set(key, dflt);
  }
  return found;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const secret = (n = 24) => {
  let out = '';
  while (out.length < n)
    for (const b of randomBytes(n * 2))
      if (b < 256 - (256 % ALPHABET.length) && out.length < n)
        out += ALPHABET[b % ALPHABET.length];
  return out;
};

const free = (taken: Set<string>, base: string, sep = '-') => {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++)
    if (!taken.has(`${base}${sep}${i}`)) return `${base}${sep}${i}`;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `name` as a whole host: `db`, `db:5432`, `http://db/x`; not `db.example.com` or `my-db`. */
const hostRe = (name: string) =>
  new RegExp(
    `(?<=^|[@=\\s,;"'(]|://)${escapeRe(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
    'g',
  );

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function existingParts(compose: string) {
  const doc = parseDocument(compose);
  if (doc.errors.length)
    throw new ValidationError(
      `The project's compose file cannot be read: ${doc.errors[0].message}`,
    );
  const js = (doc.toJS() ?? {}) as Obj;
  return {
    doc,
    services: new Set(isObj(js.services) ? Object.keys(js.services) : []),
    volumes: new Set(isObj(js.volumes) ? Object.keys(js.volumes) : []),
    variables: new Set(variablesIn(compose).keys()),
  };
}

/** Adds a template's services and volumes to a project's compose file. */
export function mergeTemplate(existing: string, tpl: Template): MergeResult {
  const cur = existingParts(existing);
  const renamed: MergeResult['renamed'] = [];

  // Variables first, in the text: a template's POSTGRES_PASSWORD must not become the one the project already has
  const tplVars = variablesIn(tpl.compose);
  const prefix = tpl.mainService.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const takenVars = new Set([...cur.variables, ...tplVars.keys()]);
  const varMap = new Map<string, string>();
  for (const key of tplVars.keys()) {
    if (!cur.variables.has(key)) continue;
    const to = free(takenVars, `${prefix}_${key}`, '_');
    takenVars.add(to);
    varMap.set(key, to);
    renamed.push({ kind: 'variable', from: key, to });
  }
  const text = tpl.compose.replace(REF, (all, braced, _op, _arg, bare) => {
    const key = (braced ?? bare) as string;
    const to = varMap.get(key);
    if (!to) return all;
    return braced ? all.replace(`{${key}`, `{${to}`) : `$${to}`;
  });

  const tplDoc = parseDocument(text);
  const js = (tplDoc.toJS() ?? {}) as Obj;
  const services = isObj(js.services)
    ? (js.services as Record<string, Obj>)
    : {};
  const volumes = isObj(js.volumes) ? (js.volumes as Obj) : {};
  if (Object.keys(services).length === 0)
    throw new ValidationError('That template has no services.');

  const takenServices = new Set([...cur.services]);
  const svcMap = new Map<string, string>();
  for (const name of Object.keys(services)) {
    const to = free(takenServices, name);
    takenServices.add(to);
    svcMap.set(name, to);
    if (to !== name) renamed.push({ kind: 'service', from: name, to });
  }
  const takenVolumes = new Set([...cur.volumes]);
  const volMap = new Map<string, string>();
  for (const name of Object.keys(volumes)) {
    const to = free(takenVolumes, name);
    takenVolumes.add(to);
    volMap.set(name, to);
    if (to !== name) renamed.push({ kind: 'volume', from: name, to });
  }

  const renameHosts = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    let out = v;
    for (const [from, to] of svcMap)
      if (from !== to) out = out.replace(hostRe(from), to);
    return out;
  };

  const out: Record<string, Obj> = {};
  for (const [name, def] of Object.entries(services)) {
    const svc: Obj = { ...def };
    if (Array.isArray(svc.depends_on))
      svc.depends_on = svc.depends_on.map((d) => svcMap.get(String(d)) ?? d);
    else if (isObj(svc.depends_on))
      svc.depends_on = Object.fromEntries(
        Object.entries(svc.depends_on).map(([k, v]) => [svcMap.get(k) ?? k, v]),
      );
    if (isObj(svc.environment))
      svc.environment = Object.fromEntries(
        Object.entries(svc.environment).map(([k, v]) => [k, renameHosts(v)]),
      );
    else if (Array.isArray(svc.environment))
      svc.environment = svc.environment.map(renameHosts);
    if (Array.isArray(svc.volumes))
      svc.volumes = svc.volumes.map((v) => {
        if (typeof v === 'string') {
          const [src, ...rest] = v.split(':');
          return volMap.has(src) ? [volMap.get(src), ...rest].join(':') : v;
        }
        if (isObj(v) && typeof v.source === 'string' && volMap.has(v.source))
          return { ...v, source: volMap.get(v.source) };
        return v;
      });
    out[svcMap.get(name) as string] = svc;
  }

  const doc = cur.doc;
  for (const [name, svc] of Object.entries(out))
    doc.setIn(['services', name], doc.createNode(svc));
  for (const [name, def] of Object.entries(volumes))
    doc.setIn(
      ['volumes', volMap.get(name) as string],
      doc.createNode(def ?? null),
    );

  // Starting values: a secret is generated, anything else starts at the template's default
  const values: Record<string, string> = {};
  const declared = new Map(tpl.variables.map((v) => [v.key, v]));
  for (const [key, dflt] of variablesIn(text)) {
    const original = [...varMap].find(([, to]) => to === key)?.[0] ?? key;
    const d = declared.get(original);
    values[key] = d?.kind === 'secret' ? secret() : (d?.default ?? dflt ?? '');
  }
  return {
    compose: doc.toString(),
    values,
    services: [...svcMap.values()],
    renamed,
  };
}

const SECRET_LIKE = /PASS|SECRET|TOKEN|KEY/i;

export const newService = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,40}$/,
        'Use lowercase letters, numbers and dashes.',
      ),
    image: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/,
        'That is not an image name.',
      ),
    port: z.number().int().min(1).max(65535).optional(),
    expose: z.boolean().default(false),
    env: z
      .array(
        z.object({
          key: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid variable name.'),
          value: z.string().max(10_000),
        }),
      )
      .max(50)
      .default([]),
    /** Where in the container to keep data: a volume named after the service is made for it */
    volumePath: z
      .string()
      .regex(/^\/[^\0:]*$/, 'The path must be absolute, like /data.')
      .refine((p) => !p.split('/').includes('..'), 'The path cannot contain ..')
      .optional(),
  })
  .strict()
  .refine((s) => !s.expose || s.port, {
    message: 'Say which port to expose.',
    path: ['port'],
  });

/** Adds one service, described by a few fields, to a project's compose file. */
export function addService(existing: string, raw: unknown): MergeResult {
  const p = newService.safeParse(raw);
  if (!p.success)
    throw new ValidationError(p.error.issues[0]?.message ?? 'Invalid input');
  const s = p.data;
  const cur = existingParts(existing);
  if (cur.services.has(s.name))
    throw new ValidationError(
      `The project already has a service called "${s.name}".`,
    );
  const renamed: MergeResult['renamed'] = [];
  const values: Record<string, string> = {};
  const taken = new Set(cur.variables);
  const prefix = s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  // Values that look like secrets become variables, so they are not written into the file (and its history)
  const environment: Record<string, string> = {};
  for (const { key, value } of s.env) {
    if (key in environment)
      throw new ValidationError(`${key} is listed twice.`);
    if (SECRET_LIKE.test(key)) {
      const name = free(taken, taken.has(key) ? `${prefix}_${key}` : key, '_');
      taken.add(name);
      if (name !== key) renamed.push({ kind: 'variable', from: key, to: name });
      environment[key] = `\${${name}}`;
      values[name] = value;
    } else environment[key] = value.replace(/\$/g, '$$$$');
  }

  const svc: Obj = { image: s.image, restart: 'unless-stopped' };
  if (Object.keys(environment).length) svc.environment = environment;
  let volume: string | undefined;
  if (s.volumePath) {
    volume = free(cur.volumes, `${s.name}-data`);
    if (volume !== `${s.name}-data`)
      renamed.push({ kind: 'volume', from: `${s.name}-data`, to: volume });
    svc.volumes = [`${volume}:${s.volumePath}`];
  }
  if (s.expose) svc['x-provelox'] = { expose: true, port: s.port };

  const doc = cur.doc;
  doc.setIn(['services', s.name], doc.createNode(svc));
  if (volume) doc.setIn(['volumes', volume], doc.createNode(null));
  return { compose: doc.toString(), values, services: [s.name], renamed };
}
