import type {
  BackendApp,
  BackendAppView,
  BackendPlan,
  BackendProject,
  BackendProjectSummary,
  BackendCiKey,
  BackendDeployment,
  BackendGroup,
  BackendMigration,
} from './backend-types';
import type { GroupsFile } from './groups';
import type {
  AppDefinition,
  BuildStatus,
  ProjectDetail,
  ProjectPlan,
  ProjectSummary,
  DeleteResult,
  StorageReport,
  VolumeMigration,
} from './types';

/** The app as the pages know it. */
export function toConsoleApp(view: BackendAppView): AppDefinition {
  const a = view.app;
  return {
    appName: a.name,
    description: '',
    hasPersistentData: a.persistent,
    instanceCount: a.instanceCount,
    deployedVersion: a.deployVersion,
    isAppBuilding: !!view.building,
    project: a.project,
    // Docker has no service for it at all: that is a failure, not a quiet app
    runState:
      view.status?.state ?? (a.instanceCount > 0 ? 'failed' : 'stopped'),
    runStatus: view.status
      ? {
          running: view.status.running,
          desired: view.status.desired,
          message: view.status.message,
          health: view.status.health,
        }
      : undefined,
    image: a.image,
    aliases: a.aliases ?? [],
    serviceAlias: a.serviceAlias,
    createdAt: a.createdAt,
    runtime: {
      command: a.command,
      entrypoint: a.entrypoint,
      workingDir: a.workingDir,
      user: a.user,
      restart: a.restart ?? 'any',
      resources: a.resources,
      healthcheck: a.healthcheck,
    },
    missingSecrets: view.missingSecrets ?? [],
    placement: a.placement,
    basicAuth: a.basicAuth
      ? {
          users: a.basicAuth.users.map((u) => u.name),
          openPaths: a.basicAuth.openPaths ?? [],
        }
      : undefined,
    cdn: a.cdn,
    sso: a.sso,
    pinnedTo: view.pinnedTo ?? null,
    notExposeAsWebApp: !a.exposed,
    disableDefaultSubDomain: !a.defaultSubdomain,
    forceSsl: a.forceSsl,
    // Traefik proxies WebSockets without being asked
    websocketSupport: true,
    containerHttpPort: a.containerPort,
    hasDefaultSubDomainSsl: a.defaultSubdomainSsl,
    primaryDomain: a.primaryDomain,
    linkedDomain: a.linkedDomain,
    customDomain: a.domains.map((d) => ({
      publicDomain: d.host,
      hasSsl: d.ssl,
    })),
    ports: a.ports.map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol,
    })),
    pendingPorts: (a.pendingPorts ?? []).map((p) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol,
    })),
    secrets: a.secrets.map(({ name, createdAt }) => ({ name, createdAt })),
    volumes: a.volumes.map((v) => ({
      containerPath: v.containerPath,
      volumeName: v.volumeName,
      hostPath: v.hostPath,
      mode: v.readOnly ? 'ro' : 'rw',
    })),
    customErrorPages: a.errorPages,
    envVars: a.env,
    versions: a.versions.map((v) => ({
      version: v.version,
      timeStamp: v.deployedAt,
      deployedImageName: v.image,
    })),
  };
}

/** The fields the console lets users change, in the backend's names. Anything not listed here is dropped. */
export interface ConsolePatch {
  disableDefaultSubDomain?: boolean;
  /** Stops the proxy answering for the app: for things that are not web pages, such as a DNS server */
  notExposeAsWebApp?: boolean;
  /** A name pointed at the server for identification, never routed. null clears it */
  linkedDomain?: string | null;
  instanceCount?: number;
  containerHttpPort?: number;
  forceSsl?: boolean;
  /** null stops the redirects */
  primaryDomain?: string | null;
  websocketSupport?: boolean;
  /** null clears a setting back to the image's own */
  command?: string[] | null;
  entrypoint?: string[] | null;
  workingDir?: string | null;
  user?: string | null;
  restart?: 'any' | 'on-failure' | 'none';
  resources?: { cpus?: number; memoryBytes?: number } | null;
  healthcheck?: {
    test: string[];
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  } | null;
  ports?: {
    containerPort: number;
    hostPort: number;
    protocol?: 'tcp' | 'udp';
    publishMode?: 'ingress' | 'host';
  }[];
  volumes?: {
    containerPath: string;
    volumeName?: string;
    hostPath?: string;
    mode?: string;
  }[];
  envVars?: { key: string; value: string }[];
  /** null removes the password; a user without a password keeps the saved one */
  basicAuth?: {
    users: (
      { name: string; password: string } | { name: string; keep: true }
    )[];
    openPaths: string[];
  } | null;
  /** null: not behind a CDN */
  cdn?: { provider: string; enforce: boolean } | null;
  /** null: no sign-in */
  sso?: {
    provider: string;
    emails: string[];
    domains: string[];
    openPaths: string[];
  } | null;
  /** Extra names other apps can reach it by on the shared network (an imported app keeps its old name) */
  aliases?: string[];
  /** null lets it run anywhere */
  placement?: { node?: string; role?: 'worker' | 'manager' } | null;
}

export function toBackendPatch(p: ConsolePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.disableDefaultSubDomain !== undefined)
    out.defaultSubdomain = !p.disableDefaultSubDomain;
  if (p.notExposeAsWebApp !== undefined) out.exposed = !p.notExposeAsWebApp;
  if (p.linkedDomain !== undefined) out.linkedDomain = p.linkedDomain;
  if (p.instanceCount !== undefined) out.instanceCount = p.instanceCount;
  if (p.containerHttpPort !== undefined)
    out.containerPort = p.containerHttpPort;
  if (p.forceSsl !== undefined) out.forceSsl = p.forceSsl;
  if (p.primaryDomain !== undefined) out.primaryDomain = p.primaryDomain;
  if (p.ports !== undefined)
    out.ports = p.ports.map((r) => ({
      containerPort: r.containerPort,
      hostPort: r.hostPort,
      protocol: r.protocol ?? 'tcp',
    }));
  if (p.volumes !== undefined)
    out.volumes = p.volumes.map((v) => ({
      containerPath: v.containerPath,
      ...(v.volumeName ? { volumeName: v.volumeName } : {}),
      ...(v.hostPath ? { hostPath: v.hostPath } : {}),
      readOnly: v.mode === 'ro',
    }));
  if (p.envVars !== undefined) out.env = p.envVars;
  if (p.placement !== undefined) out.placement = p.placement;
  if (p.aliases !== undefined) out.aliases = p.aliases;
  if (p.basicAuth !== undefined) out.basicAuth = p.basicAuth;
  if (p.cdn !== undefined) out.cdn = p.cdn;
  if (p.sso !== undefined) out.sso = p.sso;
  for (const k of [
    'command',
    'entrypoint',
    'workingDir',
    'user',
    'restart',
    'resources',
    'healthcheck',
  ] as const)
    if (p[k] !== undefined) out[k] = p[k];
  return out;
}

export function toBuildStatus(d: BackendDeployment): BuildStatus {
  return {
    isAppBuilding: d.isBuilding,
    isBuildFailed: d.isFailed,
    logs: { lines: d.lines, firstLineNumber: 0 },
  };
}

export function toMigration(m: BackendMigration): VolumeMigration {
  return {
    status: m.status,
    containerPath: m.containerPath,
    fromVolume: m.from,
    toVolume: m.volumeName,
    // the backend logs lines without times: they all happened since the move started
    steps: m.log.map((text) => ({ at: m.startedAt, text })),
    error: m.error,
    rolledBack: m.status === 'failed',
    heldVolume: m.heldVolume,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
  };
}

export function toGroupsFile(groups: BackendGroup[]): GroupsFile {
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name, appNames: g.apps })),
  };
}

export function toApiKey(k: BackendCiKey) {
  return {
    id: k.id,
    name: k.name,
    appName: k.app,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt ?? undefined,
    lastUsedImage: k.lastUsedImage ?? undefined,
  };
}

interface BackendStorage extends Omit<StorageReport, 'totals'> {
  totals: { imagesBytes: number; containers: number; volumesBytes: number };
}

/** The backend has no build cache (nothing is built there), so those totals are zero. */
export function toStorageReport(r: BackendStorage): StorageReport {
  return {
    ...r,
    totals: { ...r.totals, buildCacheBytes: 0, buildCacheReclaimableBytes: 0 },
  };
}

/** One entry per thing asked about: removed, or why it was skipped. */
export function toDeleteResults(
  r: { deleted: string[]; skipped: { id: string; reason: string }[] },
  field: 'name' | 'id',
): DeleteResult[] {
  return [
    ...r.deleted.map((id) => ({ [field]: id, removed: true }) as DeleteResult),
    ...r.skipped.map(
      (s) =>
        ({ [field]: s.id, removed: false, reason: s.reason }) as DeleteResult,
    ),
  ];
}

export type { BackendApp };

/** The plan as the dialog shows it: one line per service, without the full app definitions. */
export function toProjectPlan(p: BackendPlan): ProjectPlan {
  return {
    changes: p.changes,
    diff: p.diff ?? [],
    services: p.apps.map((a) => ({
      app: a.name,
      service:
        (a as BackendApp & { serviceAlias?: string }).serviceAlias ?? a.name,
      image: a.image,
      public: a.exposed,
      ports: a.ports.length,
      volumes: a.volumes.length,
    })),
    adopting: p.adopting ?? [],
    renaming: p.renaming ?? [],
    renameCandidates: p.renameCandidates ?? [],
    volumes: p.volumes,
    errors: p.errors,
    warnings: p.warnings,
  };
}

export function toProjectSummary(p: BackendProjectSummary): ProjectSummary {
  return { name: p.name, updatedAt: p.updatedAt, services: p.apps };
}

export function toProjectDetail(p: BackendProject): ProjectDetail {
  return {
    name: p.name,
    compose: p.compose,
    variableNames: p.variableNames,
    updatedAt: p.updatedAt,
    services: p.apps.map((v) => ({
      app: v.app.name,
      service:
        (v.app as BackendApp & { serviceAlias?: string }).serviceAlias ??
        v.app.name,
      state: v.status?.state ?? 'unknown',
      running: v.status?.running ?? 0,
      desired: v.status?.desired ?? v.app.instanceCount,
      image: v.app.image,
      host: v.app.exposed ? v.hosts[0] : undefined,
      persistent: v.app.persistent,
      volumes: v.app.volumes.map(
        (x) => x.volumeName ?? x.hostPath ?? x.containerPath,
      ),
      ports: v.app.ports.length,
      envCount: v.app.env.length,
    })),
    variables: p.variables ?? p.template?.variables ?? [],
    template: p.template ?? null,
  };
}
