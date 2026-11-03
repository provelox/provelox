import type { RuntimeSettings } from './runtime-settings';

export interface AppDefinition {
  appName: string;
  description: string;
  /** Fixed when the app is created. Only such apps can have mounted data. */
  hasPersistentData: boolean;
  instanceCount: number;
  deployedVersion: number;
  isAppBuilding?: boolean;
  /** Set when the app belongs to a Compose project: it is removed with the project, not by itself */
  project?: string;
  /** What Docker reports right now: the app's desired instance count says nothing about whether it runs */
  runState?: 'running' | 'starting' | 'failed' | 'stopped';
  /** Instances running now against instances wanted, and Docker's own message when it has one */
  runStatus?: {
    running: number;
    desired: number;
    message?: string;
    /** What the app's health check says. Missing or none: it has none. */
    health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  };
  /** The image deployed now. Empty until the first deploy. */
  image?: string;
  /** Other names apps reach it by on the shared network (an imported app keeps its old name) */
  aliases?: string[];
  /** The name other services of the same Compose project use for it */
  serviceAlias?: string;
  createdAt?: string;
  /** How the process runs: command, restart policy, limits and health check. Empty fields mean the image's own. */
  runtime?: RuntimeSettings;
  notExposeAsWebApp: boolean;
  disableDefaultSubDomain?: boolean;
  forceSsl: boolean;
  websocketSupport: boolean;
  containerHttpPort?: number;
  hasDefaultSubDomainSsl: boolean;
  /** One of the app's addresses: the others redirect to it */
  primaryDomain?: string;
  /** A name pointed at the server for identification; the proxy never answers for it */
  linkedDomain?: string;
  appDeployTokenConfig?: { enabled: boolean; appDeployToken?: string };
  customDomain: { publicDomain: string; hasSsl: boolean }[];
  ports: {
    containerPort: number;
    hostPort: number;
    protocol?: 'tcp' | 'udp';
    publishMode?: 'ingress' | 'host';
  }[];
  /** Host ports this app will publish at cutover: another platform (CapRover) still holds them */
  pendingPorts?: {
    containerPort: number;
    hostPort: number;
    protocol?: 'tcp' | 'udp';
  }[];
  secrets?: { name: string; createdAt: string }[];
  /** Names of listed secrets Docker no longer holds */
  missingSecrets?: string[];
  /** HTTP basic auth: who may sign in (names only, never the passwords) and the paths left open. Unset: no password */
  basicAuth?: { users: string[]; openPaths: string[] };
  /** The CDN in front of it. With `enforce` only that CDN's address ranges may reach the app. Unset: none */
  cdn?: { provider: string; enforce: boolean };
  /** Visitors sign in with an identity provider before the app. Unset: no sign-in */
  sso?: {
    provider: string;
    emails: string[];
    domains: string[];
    openPaths: string[];
  };
  /** Where in a cluster it may run. Unset: anywhere */
  placement?: { node?: string; role?: 'worker' | 'manager' };
  /** The machine its data is on, which holds it there. Null: free to move */
  pinnedTo?: string | null;
  volumes: {
    containerPath: string;
    volumeName?: string;
    hostPath?: string;
    mode?: string;
  }[];
  customErrorPages?: Partial<Record<'502' | '503' | '504', string>>;
  envVars: { key: string; value: string }[];
  versions: {
    version: number;
    timeStamp: string;
    deployedImageName?: string;
  }[];
}

export interface BuildStatus {
  isAppBuilding: boolean;
  isBuildFailed: boolean;
  logs: { lines: string[]; firstLineNumber: number };
}

/** Public URLs an app is reachable on. */
export function appDomains(app: AppDefinition, rootDomain: string) {
  if (app.notExposeAsWebApp) return [];
  const domains = app.customDomain.map((d) => ({
    host: d.publicDomain,
    ssl: d.hasSsl,
    isDefault: false,
  }));
  if (!app.disableDefaultSubDomain) {
    domains.unshift({
      host: `${app.appName}.${rootDomain}`,
      ssl: app.hasDefaultSubDomainSsl,
      isDefault: true,
    });
  }
  return domains;
}

/** A data mount of an app, with where it physically lives on the server. */
export interface AppMount {
  containerPath: string;
  mode?: string;
  kind: 'volume' | 'bind';
  /** bind mount: the directory on the server */
  hostPath?: string;
  /** Docker volume: its name, where Docker keeps it, and its size once measured */
  volumeName?: string;
  mountpoint?: string;
  sizeBytes?: number;
  /** Docker volume: false until the app has started once with it */
  created?: boolean;
}

/**
 * A mount found in the running container that Provelox does not manage, usually a volume the image creates by
 * itself (VOLUME in its Dockerfile). Docker makes a new empty one for every new container, so the data in it is
 * not kept across redeploys.
 */
export interface DetectedMount {
  containerPath: string;
  kind: 'volume' | 'bind';
  /** Docker made up the volume name: nobody chose to keep this data */
  anonymous: boolean;
  volumeName?: string;
  hostPath?: string;
  mountpoint?: string;
  sizeBytes?: number;
}

export interface AppMounts {
  mounts: AppMount[];
  detected: DetectedMount[];
}

/** Progress of moving an unnamed volume into a named one. Lives in Provelox's memory, not in storage. */
export interface VolumeMigration {
  status: 'running' | 'done' | 'failed';
  containerPath: string;
  fromVolume: string;
  toVolume: string;
  steps: { at: string; text: string }[];
  error?: string;
  /** The move failed and the app was restored to how it was before */
  rolledBack?: boolean;
  /**
   * Set after a failed move: the original volume is held by a helper so Docker cannot delete it. The app runs on
   * a fresh volume now, so this may be the only copy of the data until the hold is released.
   */
  heldVolume?: string;
  startedAt: string;
  finishedAt?: string;
}

export type DeleteRule = 'yes' | 'acknowledge' | 'no';

export interface StorageVolume {
  name: string;
  kind:
    | 'in-use'
    | 'declared'
    | 'provelox-orphan'
    | 'migration-original'
    | 'unnamed-orphan'
    | 'named-orphan';
  delete: DeleteRule;
  reason: string;
  sizeBytes?: number;
  createdAt?: string;
  mountpoint?: string;
  usedBy: { container: string; service?: string }[];
  app?: string;
  copiedTo?: string;
}

export interface StorageImage {
  id: string;
  tags: string[];
  sizeBytes: number;
  createdAt: number;
  kind: 'in-use' | 'system' | 'kept-version' | 'old-version' | 'other-unused';
  delete: DeleteRule;
  reason: string;
  app?: string;
  version?: number;
}

export interface StorageReport {
  totals: {
    imagesBytes: number;
    containers: number;
    volumesBytes: number;
    buildCacheBytes: number;
    buildCacheReclaimableBytes: number;
  };
  keepVersions: number;
  volumes: StorageVolume[];
  images: StorageImage[];
  reclaimable: {
    volumes: { provable: number; needsAck: number };
    images: { provable: number; needsAck: number };
  };
}

export interface DeleteResult {
  name?: string;
  id?: string;
  removed: boolean;
  reason?: string;
}

/** A CI deploy key as shown in the list (the key itself is only ever shown when it is created). */
export interface ApiKey {
  id: string;
  name: string;
  appName: string;
  createdAt: string;
  lastUsedAt?: string;
  lastUsedImage?: string;
}

/** A ready-made app (a curated compose file with the few values a person chooses). */
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Other apps connect to <project>-<mainService>:<port> */
  mainService: string;
  port?: number;
  /** Makes a web page reachable from the internet */
  publicWeb: boolean;
  /** A brand mark's name ("postgresql"), when the template has one */
  icon?: string;
  /** The registry it comes from; null for the built-in ones */
  source?: { id: string; name: string } | null;
  variables: {
    key: string;
    label: string;
    description?: string;
    default?: string;
    kind: 'text' | 'secret';
    minLength?: number;
  }[];
}

export interface PlanIssue {
  service?: string;
  message: string;
}

/** What deploying a compose file would do, shown before anything changes. */
/** What an update does to one service (the API's plan-diff): names only, never a value. */
export interface ServiceChange {
  app: string;
  service: string;
  action: 'create' | 'unchanged' | 'update' | 'restart' | 'remove';
  reasons: string[];
  briefOutage: boolean;
  secretsChanged: string[];
}

/** What an app has that a compose file cannot say, and that moving or renaming it keeps */
export interface KeptSettings {
  domains: { host: string; ssl: boolean }[];
  primaryDomain: string | null;
  /** The other settings kept, in words: password, sign-in, CDN, error pages, redirect to HTTPS */
  features: string[];
}

export interface RenameCandidate {
  /** The service's name now */
  from: string;
  /** Its name in the new file */
  to: string;
  reason: string;
}

export interface ProjectPlan {
  changes: { create: string[]; update: string[]; remove: string[] };
  diff: ServiceChange[];
  services: {
    app: string;
    service: string;
    image: string;
    public: boolean;
    ports: number;
    volumes: number;
  }[];
  /** Apps that already run and move into the project, and whether each is briefly down while it moves */
  adopting: {
    service: string;
    app: string;
    to: string;
    gap: boolean;
    keeps?: KeptSettings;
  }[];
  /** Services renamed in this update, keeping what the old app had */
  renaming: {
    from: string;
    to: string;
    app: string;
    gap: boolean;
    keeps?: KeptSettings;
  }[];
  /** Removed and added services that look like one service under a new name, for the person to confirm */
  renameCandidates: RenameCandidate[];
  volumes: string[];
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export interface ProjectSummary {
  name: string;
  updatedAt: string;
  services: string[];
}

export interface ProjectService {
  app: string;
  service: string;
  state: 'running' | 'starting' | 'failed' | 'stopped' | 'unknown';
  running: number;
  desired: number;
  image: string;
  /** The public address, when the service is exposed */
  host?: { host: string; ssl: boolean };
  /** Keeps data: runs one instance */
  persistent: boolean;
  /** Where its data lives: volume names or server directories */
  volumes: string[];
  ports: number;
  envCount: number;
}

/** A value the project's template asked for, read back from the service that was given it. */
export interface ProjectVariable {
  key: string;
  label: string;
  description?: string;
  kind: 'text' | 'secret';
  /** Null when it cannot be found any more */
  value: string | null;
  /** Where it lives on the service: "the environment variable X", "its command" */
  where: string | null;
}

/** How to reach what a template deployed: set only while the project is still exactly that template. */
export interface ProjectTemplate {
  id: string;
  name: string;
  /** A web page to open rather than something other apps connect to */
  publicWeb: boolean;
  variables: ProjectVariable[];
  connection: {
    /** What other apps on this server use */
    host: string;
    /** What the project's own services use */
    hostInProject: string;
    port: number | null;
    /** Ready to use, with every value in. Null when the template has none or a value is missing. */
    url: string | null;
    /** The same with a missing value shown as its name */
    urlTemplate: string | null;
  };
}

export interface ProjectDetail {
  name: string;
  compose: string;
  /** Variable names the file uses; their values are never stored */
  variableNames: string[];
  updatedAt: string;
  services: ProjectService[];
  /** Every variable the file asks for, with its value read back from the running services where that can be done */
  variables: ProjectVariable[];
  template: ProjectTemplate | null;
}

/** A place templates come from besides the built-in ones: an index file, or a git repository holding one. */
export interface TemplateSource {
  id: string;
  name: string;
  kind: 'index' | 'git';
  url: string;
  ref: string | null;
  path: string | null;
  hasToken: boolean;
  createdAt: string;
  syncedAt: string | null;
  error: string | null;
  templates: number;
  skipped: { id: string; reason: string }[];
}
