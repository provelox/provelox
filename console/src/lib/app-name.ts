/**
 * Referring to an app that already exists. Deliberately lenient: apps created before Provelox tightened its
 * naming rules (longer names, double dashes...) must keep working.
 */
export const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Names the platform's own services use (pvx-<name> would collide with an app of that name)
const RESERVED = ['provelox', 'traefik', 'registry'];

/** Provelox's rule for NEW apps: lowercase letters, numbers and single dashes, under 50 characters. */
export function isNewAppNameAllowed(name: string) {
  return (
    !!name &&
    name.length < 50 &&
    /^[a-z0-9]/.test(name) &&
    /[a-z0-9]$/.test(name) &&
    /^[a-z0-9-]+$/.test(name) &&
    !name.includes('--') &&
    !RESERVED.includes(name)
  );
}

/** Turns whatever was typed into the closest valid app name ("Other.com" -> "other-com"). */
export function suggestAppName(input: string) {
  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 49)
    .replace(/-+$/g, '');
  return isNewAppNameAllowed(name) ? name : '';
}

/** Why a new app name is rejected, in plain words. Null when it is valid or still empty. */
export function explainAppName(name: string): string | null {
  if (!name || isNewAppNameAllowed(name)) return null;
  if (name.includes('.')) {
    return "App names can't contain dots. Use dashes instead (other-com), and attach the domain under Domains & SSL once the app exists.";
  }
  if (name.length >= 50) return 'App names must be shorter than 50 characters.';
  if (/\s/.test(name))
    return "App names can't contain spaces. Use dashes instead.";
  if (/^-/.test(name) || /-$/.test(name))
    return 'App names must start and end with a letter or number.';
  if (name.includes('--'))
    return "App names can't contain two dashes in a row.";
  if (RESERVED.includes(name))
    return 'That name is reserved by Provelox. Pick another one.';
  return 'Use only lowercase letters, numbers and single dashes.';
}

// Public suffixes made of two labels, so "acme.co.uk" is a product called acme and not one called co
const TWO_LABEL_SUFFIXES = new Set(
  [
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
    'co.za', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'co.kr',
  ], // prettier-ignore
);

const HOST_RE =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** A host out of whatever was typed or pasted ("https://API.loxti.com/path" -> "api.loxti.com"), or null when it is not one. */
export function parseHost(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return host.length <= 80 && HOST_RE.test(host) ? host : null;
}

export interface DomainSuggestion {
  host: string;
  /** The main label of the domain: "loxti" for api.loxti.com */
  product: string;
  /** The part before it: "api" for api.loxti.com, "web" for the bare domain */
  role: string;
  /** product-role, a valid name for a new app */
  name: string;
}

/**
 * The name this platform recommends for an app that serves a domain: <product>-<role>, where the product is the domain's
 * main label and the role is its subdomain ("web" for the bare domain). api.loxti.com -> loxti-api, loxti.com ->
 * loxti-web, admin.eu.fleetstry.com -> fleetstry-admin-eu. Null when the input is not a domain or no valid name comes of it.
 */
export function suggestFromDomain(input: string): DomainSuggestion | null {
  const host = parseHost(input);
  if (!host) return null;
  const labels = host.replace(/^www\./, '').split('.');
  const suffix = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 2 : 1;
  if (labels.length <= suffix) return null;
  const product = labels[labels.length - suffix - 1];
  const sub = labels.slice(0, labels.length - suffix - 1);
  const role = sub.length ? sub.join('-') : 'web';
  const name = suggestAppName(`${product}-${role}`);
  return name ? { host, product, role, name } : null;
}

/** The collection that looks like the domain's product ("Loxti" for loxti.com), when there is exactly one. */
export function collectionForProduct<T extends { id: string; name: string }>(
  product: string,
  collections: T[],
): T | null {
  const hits = collections.filter(
    (c) =>
      suggestAppName(c.name) === product ||
      suggestAppName(c.name).startsWith(`${product}-`),
  );
  return hits.length === 1 ? hits[0] : null;
}
