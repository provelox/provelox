import { parse } from 'yaml';

/** A `${VAR}` reference found in a compose file. */
export interface ComposeVariable {
  key: string;
  /** From ${VAR:-default} / ${VAR-default} */
  default?: string;
  /** From ${VAR:?message} / ${VAR?message}: the file refuses to deploy without it */
  required: boolean;
  /** From the message of ${VAR:?...}: "at least 32 characters", or "openssl rand -hex 32" (the recipe names the length) */
  minLength?: number;
}

// A dollar that follows another is the second half of an escaped "$$", never the start of a reference
const REF =
  /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * The variables a compose file asks for, in order of first use. "$$" is a literal dollar and is skipped. A
 * variable referenced several times is reported once: it keeps a default if any reference gave one, and is
 * required if any reference requires it.
 */
export function extractVariables(compose: string): ComposeVariable[] {
  const found = new Map<string, ComposeVariable>();
  for (const m of compose.matchAll(REF)) {
    const key = (m[1] ?? m[4]) as string;
    const op = m[2];
    const arg = m[3];
    const cur = found.get(key) ?? { key, required: false };
    if ((op === ':-' || op === '-') && cur.default === undefined)
      cur.default = arg ?? '';
    if (op === ':?' || op === '?') {
      cur.required = true;
      const n =
        Number(/at least (\d+) char/i.exec(arg ?? '')?.[1]) ||
        Number(/rand -hex (\d+)/.exec(arg ?? '')?.[1]);
      if (n > 0) cur.minLength = Math.max(cur.minLength ?? 0, n);
    }
    found.set(key, cur);
  }
  return [...found.values()];
}

/**
 * For each variable, the services whose definition mentions it, in file order. Anything the file cannot be read
 * for (a syntax error, a reference outside `services:`) is left out, and the caller shows it ungrouped.
 */
export function variableServices(compose: string): Record<string, string[]> {
  let root: unknown;
  try {
    root = parse(compose, { maxAliasCount: 100 });
  } catch {
    return {};
  }
  const services = (root as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services))
    return {};
  const out: Record<string, string[]> = {};
  for (const [name, def] of Object.entries(services)) {
    for (const v of extractVariables(JSON.stringify(def ?? ''))) {
      (out[v.key] ??= []).push(name);
    }
  }
  return out;
}

/** What the file says about a variable under its top-level `x-provelox.variables` (the API enforces it too). */
export interface VariableDeclaration {
  label?: string;
  description?: string;
  default?: string;
  secret?: boolean;
  minLength?: number;
}

/** The declarations of a compose file; none (never an error) when the file is not valid YAML yet, as while it is being typed. */
export function declaredVariables(
  compose: string,
): Record<string, VariableDeclaration> {
  let root: unknown;
  try {
    root = parse(compose, { maxAliasCount: 100 });
  } catch {
    return {};
  }
  const vars = (root as { 'x-provelox'?: { variables?: unknown } } | null)?.[
    'x-provelox'
  ]?.variables;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return {};
  const out: Record<string, VariableDeclaration> = {};
  for (const [key, d] of Object.entries(vars)) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const text = (k: string) =>
      typeof r[k] === 'string' ? (r[k] as string) : undefined;
    out[key] = {
      label: text('label'),
      description: text('description'),
      default: text('default'),
      secret: r.secret === true || r.kind === 'secret',
      minLength:
        typeof r.minLength === 'number' && r.minLength > 0
          ? r.minLength
          : undefined,
    };
  }
  return out;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random password that is easy to copy: no look-alike characters, no punctuation that shells or URLs mangle. */
export function generateSecret(length = 24): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // 256 is not a multiple of the alphabet size: drop the biased tail instead of using modulo on it
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  for (const b of bytes) if (b < limit) out += ALPHABET[b % ALPHABET.length];
  return out.length === length
    ? out
    : out + generateSecret(length - out.length);
}
