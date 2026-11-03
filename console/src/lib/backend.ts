import {
  activityQuery,
  type ActivityFilters,
  type ActivityPage,
} from './activity';
import type { ImageUpdate } from './image-updates';
import 'server-only';
import {
  toProjectDetail,
  toProjectSummary,
  toApiKey,
  toBuildStatus,
  toConsoleApp,
  toGroupsFile,
  toMigration,
  toStorageReport,
} from './backend-map';
import type {
  BackendAppView,
  BackendCiKey,
  BackendDeployment,
  BackendGroup,
  BackendMigration,
  BackendProject,
  BackendProjectSummary,
  BackendRegistry,
  BackendTemplate,
} from './backend-types';
import { env } from './env';
import { toPublicRegistry } from './registries';
import { STANDARD_PORTS } from './site-url';
import type {
  AppMount,
  AppMounts,
  DetectedMount,
  TemplateSource,
} from './types';

/** A failed call to the Provelox API. `status` is the HTTP status, or 0 when it could not be reached. */
export class BackendError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
  /** The token is missing, expired or signed out (password changed): the console must sign in again. */
  get isAuthFailure() {
    return this.status === 401 && this.code !== 'rate_limited';
  }
}

/**
 * Calls the Provelox API and returns its JSON (204 → undefined). Errors come back as { error: { code, message } }
 * and are thrown as BackendError with that message, which is written for the user.
 */
export async function api<T = unknown>(
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    /** Give up sooner than the default two minutes, for calls a page waits on */
    timeoutMs?: number;
    /** The address of whoever this call is for, so the API can count a person's wrong passwords, not the console's */
    clientIp?: string | null;
  } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `${env().PROVELOX_API_URL}/v1/${path.replace(/^\/+/, '')}`,
      {
        method: init.method ?? 'GET',
        cache: 'no-store',
        headers: {
          ...(init.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.clientIp ? { 'x-forwarded-for': init.clientIp } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
      },
    );
  } catch (error) {
    console.error('Failed to reach the Provelox API', error);
    throw new BackendError(0, 'Cannot reach the Provelox API');
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as
    { error?: { code?: string; message?: string } } | T | null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)
      ?.error;
    throw new BackendError(
      res.status,
      e?.message ?? `The API returned HTTP ${res.status}`,
      e?.code,
    );
  }
  return body as T;
}

/** Signs in. The API has no second factor and no default password. */
export async function login(password: string, clientIp?: string | null) {
  return api<{ token: string }>('auth/login', {
    method: 'POST',
    body: { password },
    clientIp,
  });
}

export interface SystemInfo {
  /** Empty until a root domain has been set */
  rootDomain: string;
  /** Where apps' default addresses are (<app>.<this>): the root domain unless one is set aside for apps */
  appsDomain: string;
  /** Apps have a domain of their own, apart from the root domain */
  appsDomainCustom: boolean;
  /** The Let's Encrypt account email, needed before anything can use HTTPS */
  acmeEmail: string;
  /** Whether a new app gets <name>.<root domain> unless its creator turns that off */
  defaultSubdomainForNewApps: boolean;
  docker: 'ok' | 'unreachable';
  proxy: { enabled: boolean; running: boolean };
}

export async function loadSystemInfo(token: string): Promise<SystemInfo> {
  const [info, proxy] = await Promise.all([
    api<{
      rootDomain: string | null;
      appsDomain?: string | null;
      appsDomainCustom?: boolean;
      docker: 'ok' | 'unreachable';
      defaultSubdomainForNewApps?: boolean;
    }>('system/info', { token, timeoutMs: PAGE_TIMEOUT_MS }),
    api<{
      enabled: boolean;
      acmeEmail: string | null;
      service: { state: string } | null;
    }>('system/proxy', { token }),
  ]);
  return {
    rootDomain: info.rootDomain ?? '',
    appsDomain: info.appsDomain ?? info.rootDomain ?? '',
    appsDomainCustom: info.appsDomainCustom ?? false,
    acmeEmail: proxy.acmeEmail ?? '',
    // An API older than the console always gave new apps a default address
    defaultSubdomainForNewApps: info.defaultSubdomainForNewApps ?? false,
    docker: info.docker,
    proxy: {
      enabled: proxy.enabled,
      running: proxy.service?.state === 'running',
    },
  };
}

/** Where the platform sends word when something needs attention. */
export interface Notifications {
  webhooks: {
    id: string;
    name: string;
    /** Only the host: the rest of the address is a secret */
    host: string;
    lastStatus?: string;
    lastAt?: string;
  }[];
  events: { problem: boolean; recovered: boolean; certificate: boolean };
}

export async function loadNotifications(token: string) {
  return api<Notifications>('system/notifications', { token });
}

/** A page that is waiting on the API gives up after this and shows the waiting screen, not a spinner for two minutes. */
const PAGE_TIMEOUT_MS = 15_000;

export async function loadApps(token: string) {
  const [views, info] = await Promise.all([
    api<BackendAppView[]>('apps', { token, timeoutMs: PAGE_TIMEOUT_MS }),
    api<{
      version?: string | null;
      rootDomain: string | null;
      appsDomain?: string | null;
      httpPort?: number;
      httpsPort?: number;
      defaultSubdomainForNewApps?: boolean;
    }>('system/info', { token }),
  ]);
  return {
    appDefinitions: views.map(toConsoleApp),
    version: info.version ?? null,
    // Apps are served under their own domain when one is set aside, else the root domain: what the screens build
    // an app's address from
    rootDomain: info.appsDomain ?? info.rootDomain ?? '',
    defaultSubdomainForNewApps: info.defaultSubdomainForNewApps ?? false,
    // An API older than the console does not report them: assume the standard ports
    ports: {
      http: info.httpPort ?? STANDARD_PORTS.http,
      https: info.httpsPort ?? STANDARD_PORTS.https,
    },
  };
}

export async function loadApp(token: string, name: string) {
  return toConsoleApp(
    await api<BackendAppView>(`apps/${encodeURIComponent(name)}`, { token }),
  );
}

export async function loadGroups(token: string) {
  return toGroupsFile(await api<BackendGroup[]>('groups', { token }));
}

export async function loadDeployment(token: string, name: string) {
  return toBuildStatus(
    await api<BackendDeployment>(
      `apps/${encodeURIComponent(name)}/deployment`,
      { token },
    ),
  );
}

/** What an app's running instances use right now, with the limits they were given. */
export interface AppUsage {
  instances: number;
  /** Percent of one core, the way `docker stats` shows it: two busy cores read 200 */
  cpuPercent: number;
  memoryBytes: number;
  cpuLimitPercent: number | null;
  memoryLimitBytes: number | null;
}

/** The certificate the proxy serves for one address of an app, or why there is none. */
export interface CertificateStatus {
  host: string;
  state: 'valid' | 'expiring' | 'expired' | 'pending' | 'off' | 'unreachable';
  issuer?: string;
  expiresAt?: string;
  daysLeft?: number;
}

export async function loadCertificates(token: string, name: string) {
  return api<CertificateStatus[]>(
    `apps/${encodeURIComponent(name)}/certificates`,
    { token },
  );
}

/**
 * Whether the registries hold a newer image for each app, by app name. Provelox answers from its own cache, so this is
 * quick, and an older Provelox without the route just gives nothing: a missing answer must never break a page.
 */
export async function loadImageUpdates(
  token: string,
): Promise<Record<string, ImageUpdate>> {
  try {
    const r = await api<{ updates: ImageUpdate[] }>('system/image-updates', {
      token,
    });
    return Object.fromEntries(
      (Array.isArray(r.updates) ? r.updates : []).map((u) => [u.app, u]),
    );
  } catch {
    return {};
  }
}

/** What every running app uses right now, by app name. Stopped apps are not in it. */
export type UsageByApp = Record<
  string,
  { instances: number; cpuPercent: number; memoryBytes: number }
>;

export async function loadUsageAll(token: string) {
  return api<UsageByApp>('apps/usage', { token });
}

/** What an app used over a span: up to 120 averaged points, oldest first. */
export interface UsageHistory {
  minutes: number;
  points: { t: number; cpu: number; mem: number }[];
}

export async function loadUsageHistory(
  token: string,
  name: string,
  minutes: number,
) {
  return api<UsageHistory>(
    `apps/${encodeURIComponent(name)}/usage/history?minutes=${minutes}`,
    { token },
  );
}

export async function loadUsage(token: string, name: string) {
  return api<AppUsage>(`apps/${encodeURIComponent(name)}/usage`, { token });
}

export async function loadAppMounts(
  token: string,
  name: string,
  withSizes: boolean,
): Promise<AppMounts> {
  const data = await api<{ mounts: AppMount[]; detected: DetectedMount[] }>(
    `apps/${encodeURIComponent(name)}/volumes${withSizes ? '?sizes=1' : ''}`,
    { token },
  );
  return { mounts: data.mounts, detected: data.detected };
}

export async function loadVolumeMigration(token: string, name: string) {
  try {
    return toMigration(
      await api<BackendMigration>(
        `apps/${encodeURIComponent(name)}/volumes/migration`,
        { token },
      ),
    );
  } catch (e) {
    // "no move has run for this app" is the normal state
    if (e instanceof BackendError && e.status === 404) return null;
    throw e;
  }
}

export async function loadStorageReport(token: string, keepVersions: number) {
  return toStorageReport(
    await api(`system/storage?keepVersions=${keepVersions}`, { token }),
  );
}

export async function loadRegistries(token: string) {
  return (await api<BackendRegistry[]>('registries', { token })).map(
    toPublicRegistry,
  );
}

export async function loadApiKeys(token: string) {
  return (await api<BackendCiKey[]>('ci-keys', { token }))
    .map(toApiKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface AccessToken {
  id: string;
  name: string;
  scope: 'read' | 'operate' | 'update';
  createdAt: string;
  lastUsedAt: string | null;
}

export async function loadAccessTokens(token: string) {
  return api<AccessToken[]>('system/access-tokens', { token });
}

export async function loadPlaceholder(token: string) {
  const r = await api<{ html: string; custom: boolean }>(
    'system/placeholder-page',
    { token },
  );
  // The default page is the platform's own: the editor starts empty unless one was set
  return r.custom ? r.html : '';
}

export async function loadTemplates(token: string) {
  return api<BackendTemplate[]>('templates', { token });
}

export async function loadTemplateSources(token: string) {
  return api<TemplateSource[]>('templates/sources', { token });
}

/** One template with its compose file. */
export async function loadTemplate(token: string, id: string) {
  return api<BackendTemplate & { compose: string }>(
    `templates/${encodeURIComponent(id)}`,
    { token },
  );
}

export async function loadProjects(token: string) {
  return (await api<BackendProjectSummary[]>('projects', { token })).map(
    toProjectSummary,
  );
}

export async function loadProject(token: string, name: string) {
  return toProjectDetail(
    await api<BackendProject>(`projects/${encodeURIComponent(name)}`, {
      token,
    }),
  );
}

export interface PlatformService {
  id: 'api' | 'proxy' | 'console';
  label: string;
  installed: boolean;
  state: 'running' | 'starting' | 'failed' | 'stopped' | null;
  image: string | null;
  /** What it uses right now. Null when it is not installed or Docker would not say. */
  usage: { instances: number; cpuPercent: number; memoryBytes: number } | null;
}

/** The platform's own services. They are not apps: they cannot be stopped or deleted from the console. */
export async function loadPlatformServices(token: string) {
  return api<PlatformService[]>('system/services', { token });
}

export interface ServerNode {
  id: string;
  hostname: string;
  role: 'leader' | 'manager' | 'worker';
  state: 'ready' | 'down' | 'unknown' | 'disconnected';
  availability: 'active' | 'pause' | 'drain';
  address: string;
  cpus: number;
  memoryBytes: number;
  os: string;
  architecture: string;
  dockerVersion: string;
  /** The operating system by name and the kernel: known only for the machine the API talks to */
  osName?: string;
  kernel?: string;
}

/** Where the console and the API are served, and whether over HTTPS. */
export interface PlatformHosts {
  console: { host: string; ssl: boolean; url: string } | null;
  api: { host: string; ssl: boolean; url: string } | null;
}

/** Null for an API from before this could be read: nothing is then offered. */
export async function loadPlatformHosts(
  token: string,
): Promise<PlatformHosts | null> {
  try {
    return await api<PlatformHosts>('system/platform-hosts', { token });
  } catch (e) {
    if (e instanceof BackendError && e.status === 404) return null;
    throw e;
  }
}

/** What runs on a machine: an app or one of the platform's own services, and how many instances. */
export interface NodeWorkload {
  name: string;
  kind: 'app' | 'platform';
  count: number;
  /** An app held to this server because its data is here */
  pinned?: boolean;
}

/** A machine of the cluster, with what runs on it. */
export interface ClusterNode extends ServerNode {
  /** The machine the API talks to: it cannot be demoted or removed from here */
  isLocal: boolean;
  workloads: NodeWorkload[];
}

export interface ClusterOverview {
  nodes: ClusterNode[];
  managers: number;
  warnings: string[];
  /** This host is a Swarm manager, so machines can be joined to it */
  canJoin: boolean;
  /** Set when the apps network is not encrypted and there is more than one server: run it on a manager */
  encryptCommand?: string | null;
}

export interface JoinRole {
  token: string;
  swarmCommand: string;
  proveloxCommand: string;
}

export interface JoinInstructions {
  managerAddress: string;
  /** The image the join command runs */
  image: string;
  worker: JoinRole;
  manager: JoinRole;
  ports: string[];
}

/**
 * The cluster, with what runs on each machine. An API from before clusters were managed only lists the machines, and
 * then nothing can be changed from here.
 */
export async function loadCluster(
  token: string,
): Promise<ClusterOverview & { managed: boolean }> {
  try {
    return {
      ...(await api<ClusterOverview>('system/cluster', { token })),
      managed: true,
    };
  } catch (e) {
    if (!(e instanceof BackendError) || e.status !== 404) throw e;
    const nodes = await loadNodes(token);
    return {
      nodes: nodes.map((n) => ({ ...n, isLocal: false, workloads: [] })),
      managers: nodes.filter((n) => n.role !== 'worker').length,
      warnings: [],
      canJoin: false,
      managed: false,
    };
  }
}

/** The machines the platform runs on. */
export async function loadNodes(token: string) {
  return api<ServerNode[]>('system/nodes', { token });
}

/** The activity log: who changed what, newest first. Filters narrow it; `before` is the cursor of the page before. */
export async function loadActivity(
  token: string,
  filters: ActivityFilters = {},
  extra: { before?: number | null; limit?: number } = {},
) {
  const q = activityQuery(filters, extra);
  return api<ActivityPage>(`activity${q ? `?${q}` : ''}`, { token });
}

/**
 * The security check. `cached` only reads the last scan (and never starts one), so a page can ask on every visit;
 * `fresh` runs a new scan, which takes a few seconds; `recent` takes the last one unless it is over a minute old.
 */
export async function loadSecurity(
  token: string,
  mode: 'cached' | 'fresh' | 'recent' = 'recent',
) {
  const q =
    mode === 'cached' ? '?cached=1' : mode === 'fresh' ? '?fresh=1' : '';
  return api<import('./security').SecurityScan>(`system/security${q}`, {
    token,
  });
}

/**
 * What database an app runs and whether it can be backed up. Null when it cannot be asked: the app is stopped, runs on
 * another machine, or the container cannot be looked into. The page then simply has no database section.
 */
export async function loadDatabaseInfo(token: string, name: string) {
  try {
    return await api<import('./database-backup').DatabaseInfo>(
      `apps/${encodeURIComponent(name)}/database`,
      { token },
    );
  } catch (e) {
    if (e instanceof BackendError) return null;
    throw e;
  }
}
