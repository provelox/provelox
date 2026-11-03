export interface AuthRow {
  name: string;
  /** What was typed: empty on a saved user means keep the saved password */
  password: string;
  /** Already saved: its password cannot be shown, only replaced */
  saved: boolean;
  revealed?: boolean;
}

const NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const PATH = /^\/[A-Za-z0-9._~%/-]*$/;

/** Paths typed one per line (or separated by commas), without blanks or repeats. */
export function parsePaths(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]+/)
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
}

export type AuthPatch = {
  users: ({ name: string; password: string } | { name: string; keep: true })[];
  openPaths: string[];
};

/** What to send for the rows, or what is wrong with them: said in words, before anything is sent. */
export function buildAuthPatch(
  rows: AuthRow[],
  openPaths: string[],
): { ok: true; patch: AuthPatch } | { ok: false; error: string } {
  if (rows.length === 0) return { ok: false, error: 'Add at least one user.' };
  const names = new Set<string>();
  const users: AuthPatch['users'] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!NAME.test(name))
      return {
        ok: false,
        error: `"${name}" is not a valid user name: use letters, numbers and . _ @ -`,
      };
    if (names.has(name))
      return { ok: false, error: `${name} is listed twice.` };
    names.add(name);
    if (r.saved && !r.password) users.push({ name, keep: true });
    else if (r.password.length < 8)
      return {
        ok: false,
        error: `The password for ${name} needs at least 8 characters.`,
      };
    else users.push({ name, password: r.password });
  }
  const bad = openPaths.find((p) => !PATH.test(p) || p.length > 200);
  if (bad)
    return {
      ok: false,
      error: `"${bad}" is not a path: it starts with / and uses letters, numbers and . _ ~ % / -`,
    };
  if (openPaths.length > 20)
    return { ok: false, error: 'At most 20 open paths.' };
  return { ok: true, patch: { users, openPaths } };
}

/** A password to start from, with letters and digits only so it can be typed or pasted anywhere. */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // 54 symbols: reject bytes that would skew the choice
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    if (bytes[i] < limit) out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
