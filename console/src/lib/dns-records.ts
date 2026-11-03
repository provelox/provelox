/**
 * What to create at a DNS provider so a domain reaches an app, and what a check of it means. Pure, so each case is
 * tested without a network.
 */

// Public suffixes made of two labels, so "acme.co.uk" is a root domain and "shop.acme.co.uk" is not
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'co.in',
  'co.za',
  'com.br',
  'com.mx',
  'com.ar',
  'com.tr',
  'com.cn',
  'co.kr',
]);

/** The domain the host is registered as ("api.loxti.com" -> "loxti.com", "shop.acme.co.uk" -> "acme.co.uk"). */
export function zoneOf(host: string): string {
  const labels = host.toLowerCase().split('.');
  const keep = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** A root domain has no subdomain part: it cannot be a CNAME (a CNAME may not sit beside the zone's own records). */
export const isRootDomain = (host: string) =>
  zoneOf(host) === host.toLowerCase();

/** What a DNS provider's "name" or "host" field takes for this host: "@" for the root, else the part before the domain. */
export function recordName(host: string): string {
  const h = host.toLowerCase();
  const zone = zoneOf(h);
  return h === zone ? '@' : h.slice(0, -(zone.length + 1));
}

export interface DnsRecord {
  type: 'CNAME' | 'A' | 'AAAA';
  /** The full host, and what to type in a provider's name field */
  host: string;
  name: string;
  value: string;
  /** Why this record, in a few words */
  note: string;
}

const isV6 = (a: string) => a.includes(':');

/**
 * The records that point `host` at the server. A subdomain gets a CNAME to the app's default address (it follows the
 * server if its address changes), with address records as the alternative; a root domain cannot be a CNAME, so it gets
 * address records. `addresses` are what the default address resolves to now.
 */
export function dnsRecordsFor(input: {
  host: string;
  target: string;
  addresses: string[];
}): { primary: DnsRecord[]; alternative: DnsRecord[] } {
  const host = input.host.toLowerCase();
  const name = recordName(host);
  const addr = (a: string): DnsRecord => ({
    type: isV6(a) ? 'AAAA' : 'A',
    host,
    name,
    value: a,
    note: isV6(a) ? 'The server’s IPv6 address' : 'The server’s IPv4 address',
  });
  const addresses = [...new Set(input.addresses)].sort((a, b) =>
    isV6(a) === isV6(b) ? a.localeCompare(b) : isV6(a) ? 1 : -1,
  );
  const cname: DnsRecord = {
    type: 'CNAME',
    host,
    name,
    value: input.target,
    note: 'Follows the server if its address changes',
  };
  if (isRootDomain(host))
    return {
      primary: addresses.length
        ? addresses.map(addr)
        : [
            {
              type: 'A',
              host,
              name,
              value: 'this server’s address',
              note: 'A root domain cannot be a CNAME',
            },
          ],
      alternative: [],
    };
  return { primary: [cname], alternative: addresses.map(addr) };
}

export interface DnsStatus {
  state: 'match' | 'elsewhere' | 'none' | 'unknown';
  addresses: string[];
  expected: string[];
}

export type DnsTone = 'ok' | 'warn' | 'muted';

/** One sentence about what a DNS check found, and how worried to be. */
export function describeDns(
  host: string,
  s: DnsStatus,
): { tone: DnsTone; text: string } {
  switch (s.state) {
    case 'match':
      return { tone: 'ok', text: `${host} points here.` };
    case 'none':
      return {
        tone: 'warn',
        text: `${host} does not resolve yet. DNS changes can take a few minutes, sometimes hours.`,
      };
    case 'elsewhere':
      return {
        tone: 'warn',
        text: `${host} resolves to ${s.addresses.join(', ')}, which is not this server.`,
      };
    case 'unknown':
      return {
        tone: 'muted',
        text: 'This server cannot resolve the app’s default address, so it cannot check for you.',
      };
  }
}

/** How often to look again while DNS is not right yet, and when to stop: a person is waiting, but not for ever. */
export const DNS_POLL_MS = 10_000;
export const DNS_POLL_GIVE_UP_MS = 15 * 60_000;
