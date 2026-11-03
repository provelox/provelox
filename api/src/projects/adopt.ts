import { isMap } from 'yaml';
import type { AppDefinition } from '../apps/app.model';
import { mountSource } from '../apps/service-spec';
import { existingParts, type MergeResult } from './compose-merge';

/**
 * Moving apps that already run into a project. The project is its compose file, so the apps are first described as
 * compose services (`serviceFromApp`); what compose cannot say (the Docker volume the data is in, the address, the
 * password in front of the app) is carried over from the app when the project is deployed (`adoptDefinition`).
 */

/** What an app keeps when it joins a project, over what the compose file says. */
export const ADOPT_KEEP = [
  'exposed',
  'domains',
  'primaryDomain',
  'linkedDomain',
  'forceSsl',
  'defaultSubdomain',
  'defaultSubdomainSsl',
  'groupId',
  'createdAt',
  'placement',
  'basicAuth',
  'cdn',
  'sso',
  'errorPages',
] as const;

/**
 * What an app has that a compose file cannot say, and that the move keeps: its addresses and the settings made in
 * Networking. Shown in the review and as a comment in the generated file, so nobody has to wonder where they went.
 */
export interface KeptSettings {
  /** Custom addresses, each with whether it is served over HTTPS */
  domains: { host: string; ssl: boolean }[];
  primaryDomain: string | null;
  /** The other settings kept, in words: password, sign-in, CDN, error pages, redirect to HTTPS */
  features: string[];
}

export function keptSettings(app: AppDefinition): KeptSettings {
  const features: string[] = [];
  if (app.basicAuth?.users.length) features.push('password protection');
  if (app.sso) features.push('sign-in with an identity provider');
  if (app.cdn) features.push('CDN settings');
  if (Object.keys(app.errorPages ?? {}).length > 0)
    features.push('custom error pages');
  if (app.forceSsl && app.domains.length > 0)
    features.push('redirect to HTTPS');
  return {
    domains: app.domains.map((d) => ({ host: d.host, ssl: d.ssl })),
    primaryDomain: app.primaryDomain ?? null,
    features,
  };
}

/** The comment placed under a service in the generated file: what it keeps that the file cannot say. Empty: nothing. */
export function keptComment(app: AppDefinition): string {
  const k = keptSettings(app);
  if (k.domains.length === 0 && k.features.length === 0) return '';
  const lines = [
    ' Kept from the running app. These are set in Networking and Settings, not in this file:',
  ];
  if (k.domains.length > 0)
    lines.push(
      ` domains: ${k.domains
        .map(
          (d) =>
            `${d.host}${d.ssl || d.host === k.primaryDomain ? ` (${[d.ssl ? 'HTTPS' : '', d.host === k.primaryDomain ? 'primary' : ''].filter(Boolean).join(', ')})` : ''}`,
        )
        .join(', ')}`,
    );
  if (k.features.length > 0) lines.push(` also: ${k.features.join(', ')}`);
  return lines.join('\n');
}

/** Why an app cannot be moved into a project (what a project's compose file cannot express). Empty: it can. */
export function groupingProblems(app: AppDefinition): string[] {
  const out: string[] = [];
  if (app.project)
    out.push(`it already belongs to the project "${app.project}"`);
  if (app.blueprint) out.push('a hub manages it');
  if (!app.image) out.push('it has not been deployed yet');
  if (app.secrets.length > 0)
    out.push(
      'it uses Docker secrets, which a project cannot hold yet (see its Secrets tab)',
    );
  if (app.volumes.some((v) => v.hostPath))
    out.push(
      'it mounts a directory of the server, which a project does not allow',
    );
  if (app.pendingPorts.length > 0)
    out.push('it is waiting for a port another platform still holds');
  return out;
}

/** Moving the app means a gap while it restarts: it keeps data, or publishes a host port the old and new cannot share. */
export const needsGap = (app: AppDefinition) =>
  app.persistent || app.volumes.length > 0 || app.ports.length > 0;

const SECRET_LIKE = /PASS|SECRET|TOKEN|KEY/i;

type Obj = Record<string, unknown>;

export interface AdoptedService {
  /** The service's name in the project (the app's name, or the next free one) */
  name: string;
  service: Obj;
  /** Compose volume names it uses, to be declared at the top of the file */
  volumes: string[];
  /** Variables the service uses, with the value the app has now */
  values: Record<string, string>;
  renamed: {
    kind: 'service' | 'volume' | 'variable';
    from: string;
    to: string;
  }[];
}

const free = (taken: Set<string>, base: string, sep = '-') => {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++)
    if (!taken.has(`${base}${sep}${i}`)) return `${base}${sep}${i}`;
};

/** An app as a compose service. Names that would clash with what the project has are changed, and reported. */
export function serviceFromApp(
  app: AppDefinition,
  taken: {
    services: Set<string>;
    volumes: Set<string>;
    variables: Set<string>;
  },
): AdoptedService {
  const renamed: AdoptedService['renamed'] = [];
  const name = free(taken.services, app.name);
  if (name !== app.name)
    renamed.push({ kind: 'service', from: app.name, to: name });
  taken.services.add(name);
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  const values: Record<string, string> = {};
  const environment: Record<string, string> = {};
  for (const { key, value } of app.env) {
    // Secrets are not written into the file (and its history): they become variables, started at today's value
    if (SECRET_LIKE.test(key)) {
      const v = free(
        taken.variables,
        taken.variables.has(key) ? `${prefix}_${key}` : key,
        '_',
      );
      taken.variables.add(v);
      if (v !== key) renamed.push({ kind: 'variable', from: key, to: v });
      environment[key] = `\${${v}}`;
      values[v] = value;
    } else environment[key] = value.replace(/\$/g, '$$$$');
  }

  const svc: Obj = {
    image: app.image,
    restart:
      app.restart === 'any'
        ? 'unless-stopped'
        : app.restart === 'on-failure'
          ? 'on-failure'
          : 'no',
  };
  if (Object.keys(environment).length) svc.environment = environment;
  if (app.ports.length)
    svc.ports = app.ports.map(
      (p) =>
        `${p.hostPort}:${p.containerPort}${p.protocol === 'udp' ? '/udp' : ''}`,
    );
  if (app.command?.length) svc.command = app.command;
  if (app.entrypoint?.length) svc.entrypoint = app.entrypoint;
  if (app.workingDir) svc.working_dir = app.workingDir;
  if (app.user) svc.user = app.user;
  if (app.healthcheck) {
    const h = app.healthcheck;
    svc.healthcheck = {
      test: h.test,
      ...(h.intervalSeconds && { interval: `${h.intervalSeconds}s` }),
      ...(h.timeoutSeconds && { timeout: `${h.timeoutSeconds}s` }),
      ...(h.retries && { retries: h.retries }),
      ...(h.startPeriodSeconds !== undefined && {
        start_period: `${h.startPeriodSeconds}s`,
      }),
    };
  }
  const deploy: Obj = {};
  if (app.instanceCount !== 1 && !app.persistent)
    deploy.replicas = app.instanceCount;
  if (app.resources?.cpus || app.resources?.memoryBytes)
    deploy.resources = {
      limits: {
        ...(app.resources.cpus && { cpus: String(app.resources.cpus) }),
        ...(app.resources.memoryBytes && {
          memory: String(app.resources.memoryBytes),
        }),
      },
    };
  if (Object.keys(deploy).length) svc.deploy = deploy;

  const volumes: string[] = [];
  const mounts: string[] = [];
  for (const v of app.volumes) {
    if (!v.volumeName) continue;
    const vol = free(taken.volumes, v.volumeName);
    if (vol !== v.volumeName)
      renamed.push({ kind: 'volume', from: v.volumeName, to: vol });
    taken.volumes.add(vol);
    volumes.push(vol);
    mounts.push(`${vol}:${v.containerPath}${v.readOnly ? ':ro' : ''}`);
  }
  if (mounts.length) svc.volumes = mounts;
  if (app.exposed)
    svc['x-provelox'] = { expose: true, port: app.containerPort };
  return { name, service: svc, volumes, values, renamed };
}

/**
 * The app as it is once it is part of the project: what the compose file made of the service, with everything the file
 * cannot say kept from the app. The data stays where it is (the volumes keep their Docker names), the old name stays
 * reachable on the network, and the history carries on.
 */
export function adoptDefinition(
  planned: AppDefinition,
  old: AppDefinition,
): AppDefinition {
  const kept = Object.fromEntries(ADOPT_KEEP.map((k) => [k, old[k]]));
  const imageChanged = old.image !== planned.image;
  const version = imageChanged ? old.deployVersion + 1 : old.deployVersion;
  return {
    ...planned,
    ...kept,
    aliases: [...new Set([old.name, ...old.aliases])]
      .filter((a) => a !== planned.name)
      .slice(0, 10),
    volumes: planned.volumes.map((v) => {
      // Matched by where it is mounted: the compose volume may have been renamed, the data is where it was
      const was = old.volumes.find(
        (o) => o.volumeName && o.containerPath === v.containerPath,
      );
      return was ? { ...v, dockerName: mountSource(old, was) } : v;
    }),
    deployVersion: version,
    versions: imageChanged
      ? [
          ...old.versions,
          {
            version,
            image: planned.image,
            deployedAt: new Date().toISOString(),
          },
        ].slice(-20)
      : old.versions,
  };
}

/**
 * A compose file with the apps added as services: a new file, or `existing` with them added (its comments kept). `adopt`
 * says which service is which app, for the deploy that follows.
 */
export function groupCompose(
  existing: string | null,
  apps: AppDefinition[],
): MergeResult & { adopt: Record<string, string> } {
  const cur = existingParts(existing ?? 'services: {}\n');
  // A new file starts from an empty `services: {}`, whose flow style the services added would otherwise inherit
  if (existing === null) {
    const services = cur.doc.get('services', true);
    if (isMap(services)) services.flow = false;
  }
  const values: Record<string, string> = {};
  const renamed: MergeResult['renamed'] = [];
  const adopt: Record<string, string> = {};
  for (const app of apps) {
    const s = serviceFromApp(app, {
      services: cur.services,
      volumes: cur.volumes,
      variables: cur.variables,
    });
    const node = cur.doc.createNode(s.service);
    const kept = keptComment(app);
    if (kept) node.commentBefore = kept;
    cur.doc.setIn(['services', s.name], node);
    for (const v of s.volumes)
      cur.doc.setIn(['volumes', v], cur.doc.createNode(null));
    Object.assign(values, s.values);
    renamed.push(...s.renamed);
    adopt[s.name] = app.name;
  }
  return {
    compose: cur.doc.toString(),
    values,
    services: Object.keys(adopt),
    renamed,
    adopt,
  };
}
