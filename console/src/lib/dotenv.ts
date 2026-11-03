export interface EnvRow {
  key: string;
  value: string;
}

export interface ParseProblem {
  line: number;
  message: string;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_VARS = 200;
export const MAX_VALUE = 10_000;

/** Reads the text of a .env file, or a JSON object of names to values, into variables. */
export function parseEnv(text: string): {
  rows: EnvRow[];
  problems: ParseProblem[];
} {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return fromJson(trimmed);
  return fromDotenv(text);
}

function fromJson(text: string) {
  const problems: ParseProblem[] = [];
  const rows: EnvRow[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      rows,
      problems: [{ line: 1, message: 'That is not valid JSON.' }],
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return {
      rows,
      problems: [
        { line: 1, message: 'Expected an object of names and values.' },
      ],
    };
  for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v === 'object' && v !== null) {
      problems.push({
        line: 1,
        message: `${key}: a value must be text, a number or true/false.`,
      });
      continue;
    }
    rows.push({ key, value: v === null || v === undefined ? '' : String(v) });
  }
  return check(rows, problems);
}

/**
 * The .env format most tools write: KEY=value, `export KEY=value`, # comments, blank lines, 'single quotes' (literal),
 * "double quotes" (with \n, \t, \" and \\ escapes) and double-quoted values that run over several lines, such as a
 * private key. A # starts a comment after an unquoted value only when a space comes before it.
 */
function fromDotenv(text: string) {
  const problems: ParseProblem[] = [];
  const rows: EnvRow[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(raw.trimStart());
    if (!m) {
      problems.push({ line: i + 1, message: 'Expected NAME=value.' });
      continue;
    }
    const key = m[1];
    let rest = m[2];
    let value: string;
    if (rest.startsWith('"')) {
      // double quoted: may continue on the following lines until the closing quote
      let body = rest.slice(1);
      let end = closingQuote(body);
      const startLine = i;
      while (end === -1 && i + 1 < lines.length) {
        i++;
        body += `\n${lines[i]}`;
        end = closingQuote(body);
      }
      if (end === -1) {
        problems.push({
          line: startLine + 1,
          message: `${key}: the quote is never closed.`,
        });
        continue;
      }
      value = unescape(body.slice(0, end));
      rest = body.slice(end + 1).trim();
      if (rest && !rest.startsWith('#'))
        problems.push({
          line: i + 1,
          message: `${key}: unexpected text after the closing quote.`,
        });
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end === -1) {
        problems.push({
          line: i + 1,
          message: `${key}: the quote is never closed.`,
        });
        continue;
      }
      value = rest.slice(1, end);
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    rows.push({ key, value });
  }
  return check(rows, problems);
}

/** Index of the first unescaped double quote, or -1. */
function closingQuote(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};
function unescape(s: string) {
  return s.replace(/\\([nrt"\\])/g, (_, c: string) => ESCAPES[c]);
}

function check(rows: EnvRow[], problems: ParseProblem[]) {
  const seen = new Map<string, number>();
  const out: EnvRow[] = [];
  for (const r of rows) {
    if (!KEY.test(r.key)) {
      problems.push({
        line: 0,
        message: `${r.key}: a name uses letters, digits and underscores and does not start with a digit.`,
      });
      continue;
    }
    if (r.value.length > MAX_VALUE) {
      problems.push({
        line: 0,
        message: `${r.key}: the value is longer than ${MAX_VALUE} characters.`,
      });
      continue;
    }
    // the last one wins, as in a shell that sources the file
    const at = seen.get(r.key);
    if (at !== undefined) out[at] = r;
    else {
      seen.set(r.key, out.length);
      out.push(r);
    }
  }
  if (out.length > MAX_VARS)
    problems.push({ line: 0, message: `At most ${MAX_VARS} variables.` });
  return { rows: out, problems };
}

/** Writes variables as a .env file, quoting what needs it, so it reads back as the same variables. */
export function formatEnv(rows: EnvRow[]): string {
  return rows
    .map(({ key, value }) => {
      const plain = value !== '' && /^[A-Za-z0-9_./:@%+,=-]+$/.test(value);
      if (plain || value === '') return `${key}=${value}`;
      const esc = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      return `${key}="${esc}"`;
    })
    .join('\n');
}

export interface MergeSummary {
  added: string[];
  changed: string[];
  unchanged: string[];
  /** Only with mode "replace": variables that were there and are not in the new set */
  removed: string[];
}

/** What importing would do, and the result. `merge` adds and updates and keeps the rest; `replace` sets exactly the new ones. */
export function mergeEnv(
  current: EnvRow[],
  incoming: EnvRow[],
  mode: 'merge' | 'replace',
): { rows: EnvRow[]; summary: MergeSummary } {
  const have = new Map(current.map((r) => [r.key, r.value]));
  const summary: MergeSummary = {
    added: [],
    changed: [],
    unchanged: [],
    removed: [],
  };
  for (const r of incoming) {
    if (!have.has(r.key)) summary.added.push(r.key);
    else if (have.get(r.key) !== r.value) summary.changed.push(r.key);
    else summary.unchanged.push(r.key);
  }
  if (mode === 'replace') {
    const keep = new Set(incoming.map((r) => r.key));
    summary.removed = current.filter((r) => !keep.has(r.key)).map((r) => r.key);
    return { rows: incoming, summary };
  }
  const next = new Map(incoming.map((r) => [r.key, r.value]));
  const rows = current.map((r) =>
    next.has(r.key) ? { key: r.key, value: next.get(r.key)! } : r,
  );
  for (const r of incoming) if (!have.has(r.key)) rows.push(r);
  return { rows, summary };
}
