import type { ProjectTemplate, ProjectVariable } from './types';

/** A bullet string of the same width for a secret: enough to show something is there, not how long it is. */
export const MASK = '••••••••';

/**
 * The connection string with every secret hidden, for showing on screen. A value sits in the URL percent-encoded, so
 * that is what is looked for. Copying uses the real string.
 */
export function maskSecrets(url: string, variables: ProjectVariable[]): string {
  let out = url;
  for (const v of variables)
    if (v.kind === 'secret' && v.value)
      out = out.split(encodeURIComponent(v.value)).join(MASK);
  return out;
}

/** What to copy for "the address other apps use": host and port, or just the host when there is no port. */
export function address(
  c: ProjectTemplate['connection'],
  from: 'apps' | 'project',
) {
  const host = from === 'apps' ? c.host : c.hostInProject;
  return c.port ? `${host}:${c.port}` : host;
}
