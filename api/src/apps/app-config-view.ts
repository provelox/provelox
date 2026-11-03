import type { AppDefinition } from './app.model';

/**
 * What an access token may be told about how an app is set up. A whitelist, built field by field: a field added to
 * the app later is not shown until someone adds it here. It names things (variables, secrets, users) and never holds
 * their values, and it leaves out the command, entrypoint and health check, which can carry a password as an
 * argument, and the paths of directories on the server.
 */
export interface AppConfigView {
  instances: number;
  restart: 'any' | 'on-failure' | 'none';
  project: string | null;
  dependsOn: string[];
  network: {
    exposed: boolean;
    containerPort: number;
    forceSsl: boolean;
    primaryDomain: string | null;
    domains: { host: string; ssl: boolean }[];
    aliases: string[];
    ports: {
      hostPort: number;
      containerPort: number;
      protocol: 'tcp' | 'udp';
    }[];
  };
  /** Names only */
  environment: string[];
  secrets: string[];
  volumes: {
    containerPath: string;
    kind: 'volume' | 'directory';
    /** The Docker volume's name; a directory on the server is not named */
    name: string | null;
    readOnly: boolean;
  }[];
  resources: { cpus: number | null; memoryBytes: number | null };
  placement: { node: string | null; role: 'worker' | 'manager' | null };
  passwordProtection: { users: string[]; openPaths: string[] } | null;
  cdn: { provider: string; enforce: boolean } | null;
  sso: {
    provider: string;
    emails: string[];
    domains: string[];
    openPaths: string[];
  } | null;
  hasHealthcheck: boolean;
}

export function appConfigView(app: AppDefinition): AppConfigView {
  return {
    instances: app.instanceCount,
    restart: app.restart,
    project: app.project ?? null,
    dependsOn: [...app.dependsOn],
    network: {
      exposed: app.exposed,
      containerPort: app.containerPort,
      forceSsl: app.forceSsl,
      primaryDomain: app.primaryDomain ?? null,
      domains: app.domains.map((d) => ({ host: d.host, ssl: d.ssl })),
      aliases: [...app.aliases],
      ports: app.ports.map((p) => ({
        hostPort: p.hostPort,
        containerPort: p.containerPort,
        protocol: p.protocol,
      })),
    },
    environment: app.env.map((e) => e.key),
    secrets: app.secrets.map((s) => s.name),
    volumes: app.volumes.map((v) => ({
      containerPath: v.containerPath,
      kind: v.volumeName ? 'volume' : 'directory',
      name: v.volumeName ?? null,
      readOnly: v.readOnly,
    })),
    resources: {
      cpus: app.resources?.cpus ?? null,
      memoryBytes: app.resources?.memoryBytes ?? null,
    },
    placement: {
      node: app.placement?.node ?? null,
      role: app.placement?.role ?? null,
    },
    passwordProtection: app.basicAuth
      ? {
          users: app.basicAuth.users.map((u) => u.name),
          openPaths: [...app.basicAuth.openPaths],
        }
      : null,
    cdn: app.cdn
      ? { provider: app.cdn.provider, enforce: app.cdn.enforce }
      : null,
    sso: app.sso
      ? {
          provider: app.sso.provider,
          emails: [...app.sso.emails],
          domains: [...app.sso.domains],
          openPaths: [...app.sso.openPaths],
        }
      : null,
    hasHealthcheck: !!app.healthcheck,
  };
}
