import { parse } from 'yaml';
import type { ResolvedVariable } from '../templates/connection';
import { expandCompactKeys } from './declaration';

const REF =
  /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const SECRET_LIKE = /PASS|SECRET|TOKEN|KEY/i;

/**
 * The variables a compose file asks for, described the way a template describes its own: what the file declares under
 * `x-provelox: variables:` wins over a guess from the name. In the order of first use.
 */
export function composeVariables(
  compose: string,
): Pick<ResolvedVariable, 'key' | 'label' | 'description' | 'kind'>[] {
  let declared: Record<string, Record<string, unknown>> = {};
  try {
    const root = parse(compose, { maxAliasCount: 100 }) as {
      'x-provelox'?: { variables?: Record<string, Record<string, unknown>> };
    } | null;
    const v = root?.['x-provelox']?.variables;
    if (v && typeof v === 'object') declared = v;
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const m of compose.matchAll(REF)) keys.add((m[1] ?? m[4]) as string);
  return [...keys].map((key) => {
    const raw = declared[key];
    const d =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? expandCompactKeys(raw)
        : {};
    const secret = d.secret === true || d.kind === 'secret';
    const text = (k: string) =>
      typeof d[k] === 'string' ? (d[k] as string) : undefined;
    return {
      key,
      label: text('label') ?? key,
      description: text('description'),
      kind: (key in declared ? secret : SECRET_LIKE.test(key))
        ? 'secret'
        : 'text',
    };
  });
}
