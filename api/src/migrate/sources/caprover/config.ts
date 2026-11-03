import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainName, RESERVED_NAMES } from '../../../common/naming';
import { PASSWORD_HASH } from '../../../apps/app.model';
import type { SourceApp, SourceVolume } from '../../core/source';

/** The part of CapRover's /captain/data/config-captain.json this reads. Everything is optional: versions differ. */
interface CaproverApp {
  hasPersistentData?: boolean;
  instanceCount?: number;
  containerHttpPort?: number;
  notExposeAsWebApp?: boolean;
  forceSsl?: boolean;
  websocketSupport?: boolean;
  redirectDomain?: string;
  customDomain?: { publicDomain: string; hasSsl?: boolean }[];
  envVars?: { key: string; value?: string }[];
  volumes?: { containerPath: string; volumeName?: string; hostPath?: string }[];
  ports?: { hostPort: number; containerPort: number; protocol?: string }[];
  versions?: { version: number; deployedImageName?: string }[];
  deployedVersion?: number;
  customNginxConfig?: string;
  preDeployFunction?: string;
  serviceUpdateOverride?: string;
  /** HTTP basic auth in front of the app */
  httpAuth?: { user?: string; password?: string; passwordHashed?: string };
}

export interface CaproverConfig {
  appDefinitions?: Record<string, CaproverApp>;
}

/** CapRover's image for an app that was never deployed: a placeholder page, nothing worth moving. */
export const CAPROVER_PLACEHOLDER = 'caprover/caprover-placeholder-app';

/** CapRover's name for an app's Swarm service, and for the app on its network. */
export const caproverService = (app: string) => `srv-captain--${app}`;
/** The volume CapRover creates for a named volume: it prefixes the namespace. */
export const caproverVolumeName = (name: string) => `captain--${name}`;

export function readCaproverConfig(dir: string): CaproverConfig {
  const file = join(dir, 'data', 'config-captain.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(
      `Cannot read ${file}. Mount CapRover's folder read-only (for example -v /captain:/captain:ro) or pass --captain-dir.`,
    );
  }
}

export function caproverApps(
  config: CaproverConfig,
  opts: { rootDomain?: string } = {},
): SourceApp[] {
  const defs = config.appDefinitions ?? {};
  return Object.keys(defs).map((name) => describeApp(name, defs[name], opts));
}

function describeApp(
  name: string,
  a: CaproverApp,
  opts: { rootDomain?: string },
): SourceApp {
  const current = (a.versions ?? []).find(
    (v) => v.version === a.deployedVersion,
  );
  const deployed = current?.deployedImageName ?? '';
  const image = deployed.startsWith(`${CAPROVER_PLACEHOLDER}:`) ? '' : deployed;
  const builtOnServer = /^img-captain--/.test(image);

  const volumes: SourceVolume[] = (a.volumes ?? []).map((v) =>
    v.hostPath
      ? { containerPath: v.containerPath, hostPath: v.hostPath }
      : {
          containerPath: v.containerPath,
          volume: caproverVolumeName(v.volumeName ?? ''),
          name: v.volumeName ?? '',
        },
  );
  // CapRover publishes both TCP and UDP for a port that names no protocol
  const hostPorts = (a.ports ?? []).flatMap((p) =>
    (p.protocol ? [p.protocol] : ['tcp', 'udp']).map((protocol) => ({
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      protocol: protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
    })),
  );

  const warnings: string[] = [];
  const env = (a.envVars ?? []).map((e) => {
    let value = (e.value ?? '').replace(/\$\$cap_appname/g, name);
    if (opts.rootDomain)
      value = value.replace(/\$\$cap_root_domain/g, opts.rootDomain);
    const left = /\$\$cap_\w+/.exec(value)?.[0];
    if (left)
      warnings.push(
        `${e.key} uses a CapRover placeholder that was left as it is (${left}).`,
      );
    return { key: e.key, value };
  });

  let blocker: string | undefined;
  const nameProblem = explainName(name);
  if (nameProblem) blocker = `Name cannot be used on Provelox: ${nameProblem}`;
  else if (RESERVED_NAMES.includes(name))
    blocker = 'Name is reserved on Provelox: rename the app first.';
  else if (volumes.some((v) => v.hostPath))
    blocker = 'Mounts a directory of the server: move it by hand.';
  else if (builtOnServer)
    blocker =
      'Built from source on this server: no registry image to import. Push it to a registry first.';

  const attention: string[] = [];
  if (a.customNginxConfig?.trim())
    attention.push(
      'Has a custom nginx config, which Provelox does not carry over.',
    );
  if (a.serviceUpdateOverride?.trim())
    attention.push(
      'Has a service update override (raw Docker settings): review by hand.',
    );
  if (a.preDeployFunction?.trim())
    attention.push('Has a pre-deploy function, which Provelox does not run.');
  // CapRover redirects every other address to this one; Provelox calls it the primary address
  const primaryDomain = (a.customDomain ?? []).some(
    (d) => d.publicDomain === a.redirectDomain,
  )
    ? a.redirectDomain
    : undefined;
  if (a.redirectDomain && !primaryDomain)
    attention.push(
      `Redirects to ${a.redirectDomain}, which is not one of its custom domains: set the primary address by hand.`,
    );
  if (deployed === '')
    attention.push('No deployed version: CapRover has no image for it.');

  const notes: string[] = [];
  if (!image && deployed !== '')
    notes.push(
      'Only the CapRover placeholder page is deployed: it is imported empty.',
    );
  if (a.websocketSupport)
    notes.push('Websocket support is on (Provelox proxies websockets always).');

  const persistent = !!a.hasPersistentData || volumes.length > 0;
  if (persistent && (a.instanceCount ?? 1) > 1)
    attention.push(
      'Persistent app with several instances: Provelox runs persistent apps as one.',
    );

  // HTTP basic auth: carried over when its password can be (a hash the proxy reads, or the password itself), else the
  // plan keeps the app stopped, since starting it would put it on the internet without the password it had
  let httpAuth: SourceApp['httpAuth'];
  if (a.httpAuth?.user) {
    const h = a.httpAuth.passwordHashed;
    const pw = a.httpAuth.password;
    httpAuth = {
      user: a.httpAuth.user,
      ...(h && PASSWORD_HASH.test(h)
        ? { hash: h }
        : pw && pw.length >= 8
          ? { password: pw }
          : {}),
    };
    if (!httpAuth.hash && !httpAuth.password)
      attention.push(
        `Has HTTP basic auth (user ${a.httpAuth.user}) and its password cannot be read from CapRover's configuration. It is imported stopped: set a password under Networking → Password protection, then start it.`,
      );
  }

  return {
    name,
    image,
    imageIsLocal: builtOnServer,
    instanceCount: a.instanceCount ?? 1,
    containerPort: a.containerHttpPort ?? 80,
    exposed: !a.notExposeAsWebApp,
    forceSsl: !!a.forceSsl,
    httpAuth,
    primaryDomain,
    domains: (a.customDomain ?? []).map((d) => ({
      host: d.publicDomain,
      ssl: !!d.hasSsl,
    })),
    env,
    volumes,
    hostPorts,
    persistent,
    alias: caproverService(name),
    blocker,
    attention,
    notes,
    warnings,
  };
}
