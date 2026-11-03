export interface InterpolationResult {
  value: string;
  /** Variables that were referenced but not set (and had no default): Compose substitutes an empty string */
  unset: string[];
  /** Hard failures from ${VAR:?message} */
  errors: string[];
}

const VAR =
  /\$(?:\$|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\})/g;

/**
 * Compose variable substitution: $VAR, ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:+alt}, ${VAR+alt},
 * ${VAR:?error}, ${VAR?error}. "$$" is a literal dollar sign. The ":" forms treat an empty value like an unset one.
 */
export function interpolate(
  input: string,
  vars: Record<string, string | undefined>,
): InterpolationResult {
  const unset: string[] = [];
  const errors: string[] = [];
  // The pattern below rescans a long string that never closes a brace once per start: bounded, a value is short
  if (input.length > 4096)
    return {
      value: input,
      unset,
      errors: [
        'A value is too long to substitute variables in (4096 characters at most).',
      ],
    };
  const value = input.replace(
    VAR,
    (
      match,
      bare: string | undefined,
      braced: string | undefined,
      op?: string,
      arg = '',
    ) => {
      if (match === '$$') return '$';
      const name = (bare ?? braced) as string;
      const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
      const missing = v === undefined;
      const emptyOrMissing = missing || v === '';
      switch (op) {
        case ':-':
          return emptyOrMissing ? arg : (v as string);
        case '-':
          return missing ? arg : (v as string);
        case ':+':
          return emptyOrMissing ? '' : arg;
        case '+':
          return missing ? '' : arg;
        case ':?':
          if (emptyOrMissing) errors.push(arg || `${name} is required`);
          return v ?? '';
        case '?':
          if (missing) errors.push(arg || `${name} is required`);
          return v ?? '';
        default:
          if (missing) unset.push(name);
          return v ?? '';
      }
    },
  );
  return { value, unset, errors };
}
