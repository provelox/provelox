import { isIP } from 'node:net';

/** An IPv4 or IPv6 address range like 203.0.113.0/24 or 2001:db8::/32. A bare address counts as a single-host range. */
export function normalizeCidr(raw: string): string | null {
  const s = raw.trim();
  const [addr, bits, extra] = s.split('/');
  if (extra !== undefined) return null;
  const family = isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  if (bits === undefined) return `${addr}/${max}`;
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return `${addr}/${Number(bits)}`;
}

/** Pulls ranges out of a list: one per line, comma or space separated, `#` comments, or a JSON array of strings. */
export function parseCidrList(text: string): string[] {
  const t = text.trim();
  let items: string[];
  if (t.startsWith('[')) {
    const parsed: unknown = JSON.parse(t);
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string'))
      throw new Error('Expected a list of ranges');
    items = parsed as string[];
  } else {
    items = t
      .split('\n')
      .map((l) => l.replace(/#.*/, ''))
      .flatMap((l) => l.split(/[\s,]+/))
      .filter(Boolean);
  }
  const out: string[] = [];
  for (const i of items) {
    const c = normalizeCidr(i);
    if (!c) throw new Error(`"${i.slice(0, 60)}" is not an IP range`);
    out.push(c);
  }
  return [...new Set(out)];
}
