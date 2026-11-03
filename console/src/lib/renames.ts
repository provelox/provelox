import type { KeptSettings, RenameCandidate } from './types';

/**
 * The `renames` to send with a preview or a deploy: the new service's name to the old one's, for every suggestion the
 * person has not unchecked. A suggestion nobody has answered yet counts as accepted (it is the recommended choice).
 */
export function renamesFrom(
  candidates: RenameCandidate[],
  choice: Record<string, boolean>,
): Record<string, string> {
  return Object.fromEntries(
    candidates.filter((c) => choice[c.to] ?? true).map((c) => [c.to, c.from]),
  );
}

/** What a service keeps that the compose file cannot say, as one line each: the addresses, then the other settings. */
export function keptLines(keeps: KeptSettings | undefined): string[] {
  if (!keeps) return [];
  const lines: string[] = [];
  if (keeps.domains.length > 0)
    lines.push(
      `Addresses: ${keeps.domains
        .map((d) => {
          const tags = [
            d.ssl ? 'HTTPS' : '',
            d.host === keeps.primaryDomain ? 'primary' : '',
          ].filter(Boolean);
          return tags.length > 0 ? `${d.host} (${tags.join(', ')})` : d.host;
        })
        .join(', ')}`,
    );
  if (keeps.features.length > 0)
    lines.push(`Also: ${keeps.features.join(', ')}`);
  return lines;
}
