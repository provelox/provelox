/**
 * What a migration source (the platform being left: CapRover, Dokku, Coolify...) has to provide. Everything in `core/`
 * works on these shapes only, so a new source is one folder under `sources/` that implements `MigrationSource`.
 */
import type Docker from 'dockerode';

export type AppClass = 'ready' | 'has-data' | 'needs-attention';

export interface SourcePort {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface SourceVolume {
  containerPath: string;
  /** The Docker volume that holds the data on the old platform. */
  volume?: string;
  /** The name the volume gets on Provelox (it becomes `pvx-<app>-<name>`). */
  name?: string;
  /** A directory of the server instead of a Docker volume. */
  hostPath?: string;
}

/** One app of the old platform, in the terms Provelox understands. */
export interface SourceApp {
  name: string;
  /** The image the old platform runs now. Empty: nothing was deployed. */
  image: string;
  /** The image exists only on this server (built there from source), so Provelox cannot pull it. */
  imageIsLocal: boolean;
  instanceCount: number;
  containerPort: number;
  exposed: boolean;
  forceSsl: boolean;
  /** The address the others redirect to (CapRover's redirect domain), when it is one of the app's domains. */
  primaryDomain?: string;
  domains: { host: string; ssl: boolean }[];
  /** Values are already resolved. They can be secrets: only the keys are ever printed. */
  env: { key: string; value: string }[];
  volumes: SourceVolume[];
  /**
   * The username and password the old platform asked for before the app (HTTP basic auth). A hash Provelox's proxy can
   * read, or a plain password, when the old platform kept one; neither when it did not (then it could not be carried).
   */
  httpAuth?: { user: string; hash?: string; password?: string };
  /** Host ports the old platform publishes, one entry per protocol. */
  hostPorts: SourcePort[];
  /** Keeps data: Provelox runs it as a single instance with its volumes copied. */
  persistent: boolean;
  /** The name other apps use for it on the old platform's network. Imported apps also answer to it. */
  alias: string;
  /** The app cannot be imported at all: why. */
  blocker?: string;
  /** Imported, but not as it was: what is different or needs a look. */
  attention: string[];
  /** What the import does that is worth knowing (information, not a problem). */
  notes: string[];
  /** Things that could not be carried over exactly (an unknown placeholder in a variable, say). */
  warnings: string[];
}

export interface ServiceInfo {
  name: string;
  replicas: number;
}

/** What it takes to stop and remove the old platform. Docker access is given in; nothing here talks to Provelox. */
export interface SourceRuntime {
  /**
   * Stops an app so nothing writes to its data and its host ports are free for Provelox (Swarm refuses a second
   * service on a port, even one stopped). Returns how to put it back exactly as it was.
   */
  stopApp(app: string): Promise<{ restore(): Promise<void> }>;
  /** Resolves once the app has no running instances. */
  waitStopped(app: string): Promise<void>;
  /** Stops what serves web traffic on ports 80 and 443, so Provelox's proxy can take them. */
  stopProxy(): Promise<void>;
  /** Everything of the old platform that is still installed, in the order to stop it: its apps first, the rest last. */
  services(): Promise<ServiceInfo[]>;
  stopService(name: string): Promise<void>;
  /** Removes a service of the old platform. Never data. Must refuse a name that is not the old platform's. */
  removeService(name: string): Promise<void>;
}

export interface RuntimeContext {
  docker: Docker;
  /** Where the full spec of everything that gets stopped is saved. */
  backupDir: string;
}

export type Flags = Record<string, string | boolean>;

export interface SourceOption {
  flag: string;
  description: string;
  required?: boolean;
}

export interface MigrationSource {
  /** Used on the command line: `--from caprover`. */
  id: string;
  /** For people: "CapRover". */
  title: string;
  options: SourceOption[];
  /** Reads the old platform's configuration. Read-only: it must never change anything. */
  read(flags: Flags): Promise<SourceApp[]>;
  runtime(ctx: RuntimeContext): SourceRuntime;
}
