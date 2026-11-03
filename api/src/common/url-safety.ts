import { lookup } from 'node:dns/promises';

/**
 * Addresses a server should never be told to call on someone's behalf: the cloud metadata services and the other
 * link-local ranges (169.254.0.0/16, fe80::/10), and the unspecified address. Private and loopback addresses are
 * allowed, since a webhook or a node on the same network is ordinary. Null when the address is fine, else why not.
 */
export function unsafeTarget(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host.endsWith('.metadata.google.internal')
  )
    return 'That is a cloud metadata address.';
  // IPv4, in any of the forms a URL parser normalises to dotted decimal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 169 && b === 254) return 'Link-local addresses are not allowed.';
    if (a === 0) return 'That address is not allowed.';
  }
  if (host.includes(':')) {
    // IPv6: link-local, the unspecified address, the metadata address AWS uses, and v4-mapped link-local
    if (/^fe[89ab][0-9a-f]:/.test(host))
      return 'Link-local addresses are not allowed.';
    if (host === '::' || host === '::0') return 'That address is not allowed.';
    if (host.startsWith('fd00:ec2:'))
      return 'That is a cloud metadata address.';
    const mapped = host.match(
      /^::ffff:(?:(\d+)\.(\d+)\.\d+\.\d+|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
    );
    if (mapped) {
      if (mapped[1] !== undefined)
        return unsafeTarget(new URL(`http://${host.slice(7)}/`));
      const hi = parseInt(mapped[3], 16);
      if (hi === 0xa9fe || hi >> 8 === 0) return 'That address is not allowed.';
    }
  }
  return null;
}

/**
 * The same check on what a name resolves to, made just before connecting: a hostname that points at a metadata or
 * link-local address (an attacker's own DNS, `169.254.169.254.nip.io`) is as unsafe as the address itself. Null when
 * every address is fine, or the name does not resolve (the request will fail on its own).
 */
export async function unsafeResolved(url: URL): Promise<string | null> {
  const literal = unsafeTarget(url);
  if (literal) return literal;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return null;
  try {
    const found = await lookup(host, { all: true });
    for (const a of found) {
      const why = unsafeTarget(
        new URL(
          a.family === 6 ? `http://[${a.address}]/` : `http://${a.address}/`,
        ),
      );
      if (why) return why;
    }
  } catch {
    // does not resolve: nothing to guard
  }
  return null;
}
