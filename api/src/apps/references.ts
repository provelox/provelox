/**
 * Finding and rewriting the places another app's environment names this app by its local name on the shared network
 * (`DB_HOST=website-db`, `mysql://user:pw@website-db:3306/app`). Only whole host names count: `website-db.example.com`,
 * `my-website-db` and `/var/website-db` are other things that merely contain the name.
 */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcher(name: string) {
  return new RegExp(
    `(?<=^|[@=\\s,;"'(]|://)${escape(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
    'g',
  );
}

export const mentions = (value: string, name: string) =>
  matcher(name).test(value);

export const replaceHost = (value: string, from: string, to: string) =>
  value.replace(matcher(from), to);

/** The names of the variables whose value refers to the app. */
export function referencingKeys(
  env: { key: string; value: string }[],
  name: string,
) {
  return env.filter((e) => mentions(e.value, name)).map((e) => e.key);
}

export function rewriteEnv<T extends { key: string; value: string }>(
  env: T[],
  from: string,
  to: string,
): T[] {
  return env.map((e) => ({ ...e, value: replaceHost(e.value, from, to) }));
}
