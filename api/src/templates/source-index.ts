import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { unsafeResolved } from '../common/url-safety';
import type { Template } from './catalog';

/**
 * Template registries: somewhere other than Provelox that lists templates. A registry is an index file (JSON or YAML)
 * that lists templates, each with its Compose file inline or in a file next to the index. Its templates are deployed
 * exactly as a pasted Compose file is, with the same checks, so a registry can offer anything a person could paste, no more.
 */
export const MAX_INDEX_BYTES = 5 * 1024 * 1024;
export const MAX_COMPOSE_BYTES = 256 * 1024;
export const MAX_TEMPLATES_PER_SOURCE = 200;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const isIcon = (v: string) => {
  if (/^[a-z0-9]{2,30}$/.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
};

const variable = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  label: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  default: z.string().max(1000).optional(),
  kind: z.enum(['text', 'secret']).default('text'),
  minLength: z.number().int().min(1).max(256).optional(),
});

const entry = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,47}$/,
      'Use lowercase letters, numbers and dashes.',
    ),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  category: z.string().min(1).max(30).default('Other'),
  mainService: z.string().min(1).max(100),
  port: z.number().int().min(1).max(65535).optional(),
  connect: z.string().max(500).optional(),
  /**
   * A logo: the name of one the console has ("postgresql"), or the address of a public image (https). Anything else is
   * refused. An address is loaded by the person's browser, not by Provelox.
   */
  icon: z
    .string()
    .max(500)
    .refine(
      isIcon,
      'Use a logo name like "postgresql", or the https:// address of a public image.',
    )
    .optional(),
  publicWeb: z.boolean().default(false),
  variables: z.array(variable).max(50).default([]),
  /** The Compose file itself, or `composeFile`: its path or address, relative to the index */
  compose: z.string().max(MAX_COMPOSE_BYTES).optional(),
  composeFile: z.string().max(500).optional(),
});

const index = z.object({
  name: z.string().max(100).optional(),
  templates: z.array(z.unknown()).max(MAX_TEMPLATES_PER_SOURCE),
});

export interface ParsedIndex {
  name?: string;
  entries: (Omit<Template, 'compose'> & {
    compose?: string;
    composeFile?: string;
  })[];
  /** Entries that were not usable, and why: shown to the person who added the registry */
  skipped: { id: string; reason: string }[];
}

/** Reads an index. A bad entry is skipped (and reported) rather than spoiling the rest. */
export function parseIndex(text: string): ParsedIndex {
  let raw: unknown;
  try {
    raw = parseYaml(text); // JSON is YAML
  } catch {
    throw new Error('That is not a JSON or YAML file.');
  }
  const top = index.safeParse(Array.isArray(raw) ? { templates: raw } : raw);
  if (!top.success)
    throw new Error(
      'The file needs a "templates" list (at most ' +
        MAX_TEMPLATES_PER_SOURCE +
        ').',
    );
  const entries: ParsedIndex['entries'] = [];
  const skipped: ParsedIndex['skipped'] = [];
  const seen = new Set<string>();
  top.data.templates.forEach((t, i) => {
    const id =
      (t as { id?: unknown } | null)?.id !== undefined
        ? String((t as { id: unknown }).id)
        : `#${i + 1}`;
    const parsed = entry.safeParse(t);
    if (!parsed.success)
      return void skipped.push({
        id,
        reason: parsed.error.issues[0]?.message ?? 'Invalid',
      });
    const e = parsed.data;
    if (seen.has(e.id))
      return void skipped.push({ id, reason: 'Listed twice.' });
    if (!e.compose && !e.composeFile)
      return void skipped.push({
        id,
        reason: 'It has neither "compose" nor "composeFile".',
      });
    seen.add(e.id);
    entries.push(e as ParsedIndex['entries'][number]);
  });
  return { name: top.data.name, entries, skipped };
}

/** Where a git repository's file is served raw, for the hosts people use. */
export function rawGitUrl(repo: string, ref: string, path: string): string {
  let u: URL;
  try {
    u = new URL(repo);
  } catch {
    throw new Error(
      'Enter the repository address, like https://github.com/acme/templates.',
    );
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error('The repository address must start with https://.');
  const parts = u.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2)
    throw new Error(
      'Enter the repository address, like https://github.com/acme/templates.',
    );
  const slug = parts.join('/');
  const file = path.replace(/^\/+/, '');
  const r = encodeURIComponent(ref).replace(/%2F/g, '/');
  const host = u.hostname.toLowerCase();
  if (host === 'github.com')
    return `https://raw.githubusercontent.com/${slug}/${r}/${file}`;
  if (host === 'bitbucket.org')
    return `https://bitbucket.org/${slug}/raw/${r}/${file}`;
  if (host === 'gitlab.com' || host.startsWith('gitlab.'))
    return `${u.origin}/${slug}/-/raw/${r}/${file}`;
  // Gitea, Forgejo, Codeberg
  return `${u.origin}/${slug}/raw/branch/${r}/${file}`;
}

/** Fetches a text file for a registry: bounded in size and time, never to a metadata address, redirects followed with the same care. */
export async function fetchText(
  url: string,
  opts: { token?: string; maxBytes: number; fetchImpl?: typeof fetch },
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  let current = new URL(url);
  const origin = current.origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:')
      throw new Error('Only http and https addresses can be read.');
    const unsafe = await unsafeResolved(current);
    if (unsafe) throw new Error(unsafe);
    const headers: Record<string, string> = {
      accept: 'text/plain, application/json, */*',
    };
    // The token goes only to the address it was given for, never to wherever a redirect leads
    if (opts.token && current.origin === origin) {
      headers.authorization = `Bearer ${opts.token}`;
      headers['private-token'] = opts.token;
    }
    const res = await doFetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location') as string, current);
      continue;
    }
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? 'Nothing is there (404). Check the address, branch and path.'
          : res.status === 401 || res.status === 403
            ? `Access was refused (${res.status}). A private registry needs an access token.`
            : `The server answered ${res.status}.`,
      );
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > opts.maxBytes) throw new Error('That file is too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > opts.maxBytes) throw new Error('That file is too large.');
    return buf.toString('utf8');
  }
  throw new Error('Too many redirects.');
}

/** A path or address given in an index, as an address: relative ones are relative to the index. */
export const resolveRelative = (ref: string, base: string) =>
  new URL(ref, base).toString();
