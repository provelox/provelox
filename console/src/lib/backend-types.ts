/** What the Provelox API returns (see api/src/apps/app.model.ts). The console maps these to its own shapes. */
export interface BackendApp {
  name: string;
  /** A username and password asked for before the app. The API sends hashes; only the names are used here. */
  basicAuth?: { users: { name: string }[]; openPaths: string[] };
  /** The CDN in front of the app. With `enforce` only that CDN's address ranges may reach it */
  cdn?: { provider: string; enforce: boolean };
  /** Visitors sign in with an identity provider first; only the listed addresses and domains get through */
  sso?: {
    provider: string;
    emails: string[];
    domains: string[];
    openPaths: string[];
  };
  /** Where in a cluster it may run: one machine by hostname, or a role. Unset: anywhere */
  placement?: { node?: string; role?: 'worker' | 'manager' };
  persistent: boolean;
  image: string;
  aliases?: string[];
  /** A service's name inside its Compose project network */
  serviceAlias?: string;
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  user?: string;
  restart?: 'any' | 'on-failure' | 'none';
  resources?: { cpus?: number; memoryBytes?: number };
  healthcheck?: {
    test: string[];
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  };
  instanceCount: number;
  exposed: boolean;
  containerPort: number;
  forceSsl: boolean;
  defaultSubdomain: boolean;
  defaultSubdomainSsl: boolean;
  primaryDomain?: string;
  /** A name pointed at the server for identification; never routed */
  linkedDomain?: string;
  domains: { host: string; ssl: boolean }[];
  env: { key: string; value: string }[];
  ports: { containerPort: number; hostPort: number; protocol: 'tcp' | 'udp' }[];
  /** Host ports the app is meant to publish once another platform lets go of them */
  pendingPorts?: {
    containerPort: number;
    hostPort: number;
    protocol: 'tcp' | 'udp';
  }[];
  volumes: {
    containerPath: string;
    volumeName?: string;
    hostPath?: string;
    readOnly: boolean;
  }[];
  errorPages: Partial<Record<'502' | '503' | '504', string>>;
  secrets: { name: string; createdAt: string }[];
  groupId: string | null;
  project?: string;
  deployVersion: number;
  versions: { version: number; image: string; deployedAt: string }[];
  createdAt: string;
}

export interface BackendAppView {
  app: BackendApp;
  status: {
    desired: number;
    running: number;
    state: 'running' | 'starting' | 'failed' | 'stopped';
    message?: string;
    health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  } | null;
  /** Secrets the app lists that Docker no longer holds (a rebuilt Swarm): it cannot start until they are set again */
  missingSecrets?: string[];
  hosts: { host: string; ssl: boolean }[];
  /** The machine an app with local volumes is held to (its data is there) */
  pinnedTo?: string | null;
  building?: boolean;
}

export interface BackendDeployment {
  isBuilding: boolean;
  isFailed: boolean;
  lines: string[];
}

export interface BackendMigration {
  app: string;
  containerPath: string;
  volumeName: string;
  from: string;
  status: 'running' | 'done' | 'failed';
  log: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  heldVolume?: string;
}

export interface BackendGroup {
  id: string;
  name: string;
  createdAt: string;
  apps: string[];
}

export interface BackendRegistry {
  id: string;
  domain: string;
  username: string;
  createdAt: string;
}

export interface BackendCiKey {
  id: string;
  name: string;
  app: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedImage: string | null;
}

export interface BackendTemplateVariable {
  key: string;
  label: string;
  description?: string;
  default?: string;
  kind: 'text' | 'secret';
  minLength?: number;
}

export interface BackendTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  mainService: string;
  port?: number;
  publicWeb: boolean;
  icon?: string;
  source?: { id: string; name: string } | null;
  variables: BackendTemplateVariable[];
}

export interface BackendPlan {
  project: string;
  changes: { create: string[]; update: string[]; remove: string[] };
  /** Missing from an older API */
  diff?: import('./types').ServiceChange[];
  apps: BackendApp[];
  /** Missing from an older API */
  adopting?: {
    service: string;
    app: string;
    to: string;
    gap: boolean;
    keeps?: import('./types').KeptSettings;
  }[];
  /** Missing from an older API */
  renaming?: {
    from: string;
    to: string;
    app: string;
    gap: boolean;
    keeps?: import('./types').KeptSettings;
  }[];
  /** Missing from an older API */
  renameCandidates?: import('./types').RenameCandidate[];
  volumes: string[];
  errors: { service?: string; message: string }[];
  warnings: { service?: string; message: string }[];
}

export interface BackendProjectSummary {
  name: string;
  updatedAt: string;
  apps: string[];
}

import type { ProjectTemplate } from './types';

export interface BackendProject {
  name: string;
  compose: string;
  variableNames: string[];
  updatedAt: string;
  apps: BackendAppView[];
  variables?: import('./types').ProjectVariable[];
  template?: ProjectTemplate | null;
}

export interface BackendDeployResult {
  project: string;
  apps: { name: string; action: 'created' | 'updated' }[];
  removed: string[];
  warnings: { service?: string; message: string }[];
}
