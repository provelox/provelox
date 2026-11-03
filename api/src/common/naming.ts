/**
 * Names this service puts on Docker resources. These are compatibility contracts: changing one orphans
 * everything already created under the old name. See DESIGN.md.
 */
export const LABEL_MANAGED = 'io.provelox.managed';
export const LABEL_APP = 'io.provelox.app';
export const LABEL_PROJECT = 'io.provelox.project';
export const SHARED_NETWORK = 'provelox-net';

export const serviceName = (app: string) => `pvx-${app}`;
export const projectNetwork = (project: string) => `pvx-net-${project}`;
/** Docker volume name for a named volume owned by an app, or by a project when shared between its services */
export const volumeName = (owner: string, name: string) =>
  `pvx-${owner}-${name}`;

const NAME = /^[a-z0-9]([a-z0-9-]{0,47}[a-z0-9])?$/;

/** DNS-label-safe: lowercase letters, digits and single dashes, 1-49 chars, no leading/trailing dash. */
export function isValidName(name: string): boolean {
  return NAME.test(name) && !name.includes('--');
}

export function explainName(name: string, what = 'App'): string | null {
  if (!name) return `${what} name is required.`;
  if (name.length > 49) return `${what} names must be at most 49 characters.`;
  if (/[A-Z]/.test(name)) return `${what} names must be lowercase.`;
  if (name.includes('--'))
    return `${what} names cannot contain two dashes in a row.`;
  if (!isValidName(name))
    return `${what} names use lowercase letters, numbers and single dashes, and start and end with a letter or number.`;
  return null;
}

/** Names the platform itself uses; apps may not take them. */
/**
 * Names the platform's own services use: `pvx-<name>` would collide with an app of that name, so apps may not take
 * them. ("provelox" is the API itself, "traefik" the proxy.)
 */
export const RESERVED_NAMES = ['provelox', 'traefik', 'console', 'registry'];
