/**
 * YAML needs a space after the colon: `{secret:true}` is one key, named "secret:true", with nothing after it. People
 * write it that way anyway (it reads as JSON), so a key that is really `name:value` is split back into the two things
 * it was meant to be. Used wherever a variable's declaration under `x-provelox: variables:` is read, so every place
 * agrees on what a file says.
 */
export function expandCompactKeys(
  declaration: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(declaration)) {
    const m = value == null ? /^([A-Za-z_][\w-]*):(\S.*)$/.exec(key) : null;
    if (!m) {
      out[key] = value;
      continue;
    }
    const raw = m[2].trim();
    out[m[1]] =
      raw === 'true'
        ? true
        : raw === 'false'
          ? false
          : /^-?\d+$/.test(raw)
            ? Number(raw)
            : raw.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
