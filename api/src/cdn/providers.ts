import { parseCidrList } from './cidr';

/**
 * A CDN or other proxy that sits in front of the proxy. `ranges` are the addresses it connects from: what Provelox
 * trusts X-Forwarded-For from and, per app, what it lets through. `clientIpHeader` is the header that carries the
 * visitor's address for the app to read (informational: Provelox passes it along unchanged).
 */
export interface CdnProvider {
  id: string;
  label: string;
  clientIpHeader: string | null;
  builtin: boolean;
  /** Where the ranges are fetched from. Empty for a provider with a fixed list. */
  urls: string[];
  /** Turns each fetched body into ranges */
  parse: (bodies: string[]) => string[];
  /** A fixed list (custom providers without a URL) */
  fixed?: string[];
}

const awsCloudFront = (bodies: string[]): string[] => {
  const d = JSON.parse(bodies[0]) as {
    prefixes?: { ip_prefix: string; service: string }[];
    ipv6_prefixes?: { ipv6_prefix: string; service: string }[];
  };
  // The addresses CloudFront connects to an origin from, not every edge range it has
  const svc = 'CLOUDFRONT_ORIGIN_FACING';
  return parseCidrList(
    JSON.stringify([
      ...(d.prefixes ?? [])
        .filter((p) => p.service === svc)
        .map((p) => p.ip_prefix),
      ...(d.ipv6_prefixes ?? [])
        .filter((p) => p.service === svc)
        .map((p) => p.ipv6_prefix),
    ]),
  );
};

const fastly = (bodies: string[]): string[] => {
  const d = JSON.parse(bodies[0]) as {
    addresses?: string[];
    ipv6_addresses?: string[];
  };
  return parseCidrList(
    JSON.stringify([...(d.addresses ?? []), ...(d.ipv6_addresses ?? [])]),
  );
};

export const BUILTIN_PROVIDERS: CdnProvider[] = [
  {
    id: 'cloudfront',
    label: 'Amazon CloudFront',
    clientIpHeader: 'CloudFront-Viewer-Address',
    builtin: true,
    urls: ['https://ip-ranges.amazonaws.com/ip-ranges.json'],
    parse: awsCloudFront,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    clientIpHeader: 'CF-Connecting-IP',
    builtin: true,
    urls: [
      'https://www.cloudflare.com/ips-v4',
      'https://www.cloudflare.com/ips-v6',
    ],
    parse: (b) => parseCidrList(b.join('\n')),
  },
  {
    id: 'fastly',
    label: 'Fastly',
    clientIpHeader: 'Fastly-Client-IP',
    builtin: true,
    urls: ['https://api.fastly.com/public-ip-list'],
    parse: fastly,
  },
];

/** What a person saves for a CDN Provelox does not know: a name, and a list of ranges or an address to fetch them from. */
export interface CustomCdn {
  id: string;
  label: string;
  clientIpHeader: string | null;
  url?: string;
  cidrs?: string[];
}

export function providerOf(c: CustomCdn): CdnProvider {
  return {
    id: c.id,
    label: c.label,
    clientIpHeader: c.clientIpHeader,
    builtin: false,
    urls: c.url ? [c.url] : [],
    parse: (b) => parseCidrList(b.join('\n')),
    fixed: c.url ? undefined : (c.cidrs ?? []),
  };
}
