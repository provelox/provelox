import type { Readable } from 'node:stream';
import type { SwarmServiceSpec } from '../apps/service-spec';
import type {
  ContainerFact,
  ImageFact,
  VolumeFact,
} from '../storage/storage-classifier';
import type { LogLine } from '../utils/docker-log';
import type { Health } from './health';
import type { ServiceUsage } from './usage';

/** Credentials Docker uses to pull an image from a private registry */
export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

/** Everything on this machine that Provelox made, found by its `io.provelox.managed` label. */
export interface ManagedObjects {
  services: { name: string; image: string; labels: Record<string, string> }[];
  networks: { name: string; project?: string }[];
  volumes: { name: string; project?: string }[];
  secrets: string[];
  configs: string[];
}

export type ManagedKind =
  'service' | 'network' | 'volume' | 'secret' | 'config';

export interface ContainerMount {
  type: string;
  /** Volume name (anonymous volumes have a long hex name) */
  name?: string;
  destination: string;
  readOnly: boolean;
}

export interface HelperSpec {
  image: string;
  command: string[];
  mounts: { volume: string; target: string; readOnly: boolean }[];
  /** Replaces the image's own entrypoint, which would otherwise run first with `command` as its arguments */
  entrypoint?: string[];
  /**
   * Sees the processes of the host rather than only its own. The helper then also runs with no capabilities, a
   * read-only filesystem and a memory cap, since it is only there to look.
   */
  hostPid?: boolean;
  /**
   * Needs `hostPid`. Also sees the host's whole filesystem at /host, read only, and may read files whatever their
   * permissions and see which program another process runs (two added capabilities, DAC_READ_SEARCH and SYS_PTRACE,
   * so root's own files and /proc/<pid>/exe can be looked at). Nothing is writable and there is no network.
   */
  hostRoot?: boolean;
  /** How much of the end of the helper's output is returned. 4000 characters when not set. */
  maxOutput?: number;
}

export interface ServiceStatus {
  desired: number;
  running: number;
  /** running: all desired tasks run. starting: converging. failed: tasks keep failing. stopped: scaled to zero */
  state: 'running' | 'starting' | 'failed' | 'stopped';
  /** Docker's own update progress, e.g. "updating", "completed", "rollback_started" */
  updateState?: string;
  message?: string;
  image?: string;
  /** What the app's own health check says about its running instances. Missing or none: it has no check. */
  health?: Health;
}

/** One machine in the Swarm, reduced to what the console shows. */
export interface NodeInfo {
  id: string;
  hostname: string;
  role: 'leader' | 'manager' | 'worker';
  /** Whether Docker can reach it */
  state: 'ready' | 'down' | 'unknown' | 'disconnected';
  /** Whether it accepts new work */
  availability: 'active' | 'pause' | 'drain';
  address: string;
  cpus: number;
  memoryBytes: number;
  os: string;
  architecture: string;
  dockerVersion: string;
  /**
   * The operating system by name ("Ubuntu 24.04.1 LTS") and the kernel. Docker only tells this about the machine the
   * API talks to, so other machines of a Swarm have neither: `os` is just "linux" for them.
   */
  osName?: string;
  kernel?: string;
}

/** What another machine needs to join this Swarm. The tokens are secrets: whoever holds one can join. */
export interface SwarmJoinInfo {
  workerToken: string;
  managerToken: string;
  /** host:port of this manager, as other machines should reach it */
  managerAddress: string;
}

/** One running task of a service and the machine it runs on. */
export interface NodeTask {
  service: string;
  nodeId: string;
}

/** A short-lived container whose output is handed on as it is produced, for data too big to hold (an archive of a volume) */
export interface StreamHelperSpec {
  image: string;
  entrypoint: string[];
  command: string[];
  /**
   * Volumes by their Docker name, or, for the one folder of imports, an absolute path on the host (Docker treats a source
   * that starts with "/" as a bind mount). Mounted as asked: a download mounts read-only.
   */
  mounts: { volume: string; target: string; readOnly: boolean }[];
  /**
   * Written to the program's standard input as it arrives (a restore reads its archive this way), and standard input is
   * closed when it ends. Slow program, slow reading: nothing is held in memory. Without it the program has no input.
   */
  input?: Readable;
  /** Linux capabilities kept, out of none (everything is dropped first). The default only reads files whatever their owner. */
  capabilities?: string[];
  /** Which kind of helper this is (the container's `io.provelox.helper` label). Default `download`. */
  kind?: 'download' | 'restore' | 'import';
}

/** A running streaming helper. Whatever way it ends, the container is removed. */
export interface HelperStream {
  /** What the program writes. Slow reading slows the program down; nothing is held in memory. */
  stdout: Readable;
  /** Resolves when the program has exited and its output has been handed over. Never rejects. */
  done: Promise<{ exitCode: number; stderr: string }>;
  /** Stops it now (the reader went away) and removes the container. Safe to call more than once. */
  abort(): Promise<void>;
}

/** A command to run inside a running container of this machine, with what it reads and writes as streams */
export interface ExecStreamSpec {
  /** The container's id (from `serviceContainer`) */
  container: string;
  /** The program and its arguments. Never a string put together from what a person typed. */
  cmd: string[];
  /** Written to the program's standard input, which is closed when this ends */
  input?: NodeJS.ReadableStream;
}

/** A command running inside a container */
export interface ExecStream {
  /** What the program writes. Slow reading slows the program down; nothing is held in memory. */
  stdout: Readable;
  /** Resolves when the program has exited and its output has been handed over. Never rejects. */
  done: Promise<{ exitCode: number; stderr: string }>;
  /** Stops it now: the connection is closed and the program is killed inside the container. Safe to call twice. */
  abort(): Promise<void>;
}

/**
 * Everything the service needs from Docker. A port so the business logic can be tested with a fake, and so
 * the ownership rules live in one place (the real adapter).
 */
export interface DockerPort {
  ping(): Promise<void>;
  /** Whether this Docker host is in a Swarm, and whether it can manage it. */
  swarmState(): Promise<'none' | 'manager' | 'worker'>;
  /** Starts a single-node Swarm on this host. */
  swarmInit(advertiseAddr?: string): Promise<void>;
  /**
   * The image reference this process's own container was started from (what `docker run <image>` was given), or
   * null when it is not running in a container or Docker cannot say.
   */
  selfImage(): Promise<string | null>;
  /** The machines in the Swarm. Empty when this host is not a Swarm manager. */
  listNodes(strict?: boolean): Promise<NodeInfo[]>;
  /** The id Swarm gives the machine this process talks to, or null when it is not in a Swarm. */
  localNodeId(): Promise<string | null>;
  /** The tokens and address for joining another machine. Null when this host is not a manager. */
  swarmJoinInfo(): Promise<SwarmJoinInfo | null>;
  /** Issues a new token for a role, so the old one no longer works. */
  rotateJoinToken(role: 'worker' | 'manager'): Promise<void>;
  /** Joins this host to another Swarm. */
  swarmJoin(opts: {
    token: string;
    remoteAddr: string;
    advertiseAddr?: string;
  }): Promise<void>;
  /** Changes whether a machine takes new work, or whether it is a manager. */
  updateNode(
    id: string,
    change: {
      availability?: 'active' | 'pause' | 'drain';
      role?: 'worker' | 'manager';
    },
  ): Promise<void>;
  /** Removes a machine from the Swarm. Docker refuses one that is still up unless forced. */
  removeNode(id: string, force: boolean): Promise<void>;
  /** Every task that should be running, with the machine it is on. */
  nodeTasks(): Promise<NodeTask[]>;
  /** The machine the service's most recent task was placed on, whatever its state. Null when it has never had one. */
  lastTaskNode(service: string): Promise<string | null>;
  /** Creates the overlay network if it is missing. Never touches one this service did not create. */
  ensureNetwork(name: string, owner: { project?: string }): Promise<void>;
  /** Names of the overlay networks Provelox made whose traffic between machines is not encrypted */
  unencryptedNetworks(): Promise<string[]>;
  /**
   * Replaces one of Provelox's overlay networks with an encrypted one: every service on it is taken off, the network is
   * recreated, and each service is put back with its own aliases. They restart briefly. Returns what it moved.
   */
  encryptNetwork(name: string): Promise<{ services: string[] }>;
  /** Removes a network only if it carries this service's label for that project. */
  removeNetwork(name: string, project: string): Promise<boolean>;
  /** Names of the Docker volumes labelled as belonging to this project (they outlive its services) */
  listProjectVolumes(project: string): Promise<string[]>;
  /** Stores a value as a Swarm secret. Secrets are immutable: a new value needs a new name. */
  ensureSecret(
    name: string,
    value: string,
    labels: Record<string, string>,
  ): Promise<{ id: string; name: string }>;
  /** Removes a secret only if it carries our label for this app. Returns false when it was not there. */
  removeSecret(name: string, app: string): Promise<boolean>;
  /** The ids of every secret Docker holds: an app whose secrets are not all here cannot start. */
  secretIds(): Promise<Set<string>>;
  /** Creates an immutable Swarm config (name should contain a content hash). Returns the existing one if present. */
  ensureConfig(
    name: string,
    content: string,
    labels: Record<string, string>,
  ): Promise<{ id: string; name: string }>;
  /** Removes configs of ours whose name starts with `prefix` and is not in `keep`. Ones still in use are skipped. */
  pruneConfigs(prefix: string, keep: string[]): Promise<void>;
  /**
   * `auth` is passed to the nodes so they can pull a private image. `forceRollout` replaces the running tasks even
   * when the definition is unchanged: a moving tag such as `latest` names a new image under the same text, and
   * Swarm would otherwise see nothing to do.
   */
  applyService(
    spec: SwarmServiceSpec,
    app: string,
    auth?: RegistryAuth,
    opts?: { forceRollout?: boolean },
  ): Promise<'created' | 'updated'>;
  /** A service's own labels (routing, say), or null when it does not exist. */
  serviceLabels(name: string): Promise<Record<string, string> | null>;
  /**
   * Changes a running service's definition in place: `edit` gets the current one and returns the new one. Changing
   * only labels does not restart anything. False when the service does not exist.
   */
  editService(
    name: string,
    app: string,
    edit: (spec: SwarmServiceSpec) => SwarmServiceSpec,
    /**
     * `auth` is the sign-in for a private image the edit switches to. Without it Docker keeps whatever sign-in the
     * service already has, which for a service installed without one is none.
     */
    opts?: { auth?: RegistryAuth },
  ): Promise<boolean>;
  /**
   * Whether Docker could pull `image` (a tag, say) with `auth`, asked of the registry without pulling anything. The
   * reason is the registry's own words ("no basic auth credentials", "manifest unknown").
   */
  canPull(
    image: string,
    auth?: RegistryAuth,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Reads a service's logs, calling `onLine` for each line. With `follow` it keeps going until `signal` aborts or
   * the service goes away; otherwise it returns after the last of the `tail` lines.
   */
  followLogs(
    service: string,
    opts: { tail: number; follow: boolean },
    onLine: (line: LogLine) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Everything on the host that takes disk: volumes (with sizes), containers and images */
  storageFacts(): Promise<{
    volumes: VolumeFact[];
    containers: ContainerFact[];
    images: ImageFact[];
  }>;
  /** The host's volumes with labels and mount points. Sizes make Docker walk every volume, so they are opt-in. */
  volumeFacts(withSizes: boolean): Promise<VolumeFact[]>;
  /** Plain removal, never forced: Docker itself refuses a volume or image that is in use */
  removeVolume(name: string): Promise<void>;
  removeImage(id: string): Promise<void>;
  /** What the service's containers have mounted right now (the declared mounts and any the image created itself) */
  serviceMounts(service: string): Promise<ContainerMount[]>;
  /** CPU and memory the service's running instances use right now. Null when Docker has no such service. */
  serviceUsage(service: string): Promise<ServiceUsage | null>;
  /** How many running containers the service still has: zero once a scale-down has fully finished */
  countContainers(service: string): Promise<number>;
  volumeExists(name: string): Promise<boolean>;
  /** Creates a labelled volume. Throws if it already exists. */
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  /**
   * Holds a volume in use with an idle read-only container. Swarm deletes an unnamed volume together with the
   * stopped container that created it, and Docker never removes a volume another container still uses, so this keeps
   * the data alive until the hold is released. Returns an id for `releasePin`.
   */
  pinVolume(volume: string, image: string, app: string): Promise<string>;
  releasePin(id: string): Promise<void>;
  /** Releases every hold belonging to an app. Returns how many. */
  releasePins(app: string): Promise<number>;
  /** Runs a short-lived container to completion and returns its exit code and output. It is always removed. */
  runHelper(spec: HelperSpec): Promise<{ exitCode: number; output: string }>;
  /** The image of every service, exactly as the Swarm holds it (with the `@sha256:` it resolved the tag to), by name */
  serviceImages(): Promise<Record<string, string>>;
  /** Which service or container each running container belongs to, by the first 12 characters of its id */
  containerOwners(): Promise<Record<string, string>>;
  /** Throws when the registry rejects these credentials */
  checkRegistryAuth(auth: RegistryAuth): Promise<void>;
  /** Removes the app's service if, and only if, it is provably this app's. */
  removeService(name: string, app: string): Promise<boolean>;
  serviceStatus(name: string): Promise<ServiceStatus | null>;
  /** What Provelox has made here: only objects carrying its managed label, so nothing of yours is listed */
  managedObjects(): Promise<ManagedObjects>;
  /** Removes one object, if it carries Provelox's managed label. False when it is gone; throws when it is not ours. */
  removeManaged(kind: ManagedKind, name: string): Promise<boolean>;
  /**
   * Starts a helper with no network, no privileges but reading any file, a read-only filesystem and a memory cap, and
   * hands its output over as a stream. For exporting the contents of a volume.
   */
  streamHelper(spec: StreamHelperSpec): Promise<HelperStream>;
  /** The id of a running container of the service on this machine, or null when it has none here */
  serviceContainer(service: string): Promise<string | null>;
  /**
   * Runs a command inside a running container and hands its output over as a stream, with an optional input. For the
   * database's own dump and restore tools, which are in the app's image, with the app's own credentials in reach.
   */
  execStream(spec: ExecStreamSpec): Promise<ExecStream>;
}

export const DOCKER = Symbol('DOCKER');
