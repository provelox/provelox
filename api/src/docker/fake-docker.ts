import { ConflictError, NotFoundError, OwnershipError } from '../common/errors';
import { LABEL_APP, LABEL_MANAGED, LABEL_PROJECT } from '../common/naming';
import type { SwarmServiceSpec } from '../apps/service-spec';
import type {
  ContainerFact,
  ImageFact,
  VolumeFact,
} from '../storage/storage-classifier';
import { Readable } from 'node:stream';
import type { LogLine } from '../utils/docker-log';
import type { Health } from './health';
import type { ServiceUsage } from './usage';
import type {
  ContainerMount,
  DockerPort,
  ExecStream,
  ExecStreamSpec,
  ManagedKind,
  ManagedObjects,
  HelperSpec,
  HelperStream,
  StreamHelperSpec,
  RegistryAuth,
  NodeInfo,
  ServiceStatus,
  SwarmJoinInfo,
} from './docker.port';

/** In-memory Docker for tests. Enforces the same ownership rules as the real adapter. */
export class FakeDocker implements DockerPort {
  services = new Map<string, SwarmServiceSpec>();
  networks = new Map<string, Record<string, string>>();
  calls: string[] = [];
  /** Make the next applyService fail, to test that nothing is persisted */
  failNextApply?: Error;
  statusOverride?: (name: string) => ServiceStatus | null;

  nodes: NodeInfo[] = [];
  swarm: 'none' | 'manager' | 'worker' = 'manager';
  self: string | null = null;
  swarmInitError?: Error;

  async swarmState() {
    return this.swarm;
  }

  async swarmInit(advertiseAddr?: string) {
    this.calls.push(`swarm-init:${advertiseAddr ?? ''}`);
    if (this.swarmInitError) throw this.swarmInitError;
    this.swarm = 'manager';
  }

  async selfImage() {
    return this.self;
  }

  async ping() {}

  /** Make the next strict node listing fail, as a Docker error would */
  nodesError?: Error;

  async listNodes(strict = false) {
    if (strict && this.nodesError) throw this.nodesError;
    return this.nodes;
  }

  /** The machine this fake "talks to": the first one listed */
  /** Networks the fake reports as not encrypted, for tests of the warning */
  plainNetworks: string[] = [];

  async unencryptedNetworks() {
    return this.plainNetworks;
  }

  async encryptNetwork(name: string) {
    this.calls.push(`encrypt:${name}`);
    this.plainNetworks = this.plainNetworks.filter((n) => n !== name);
    return { services: [...this.services.keys()] };
  }

  async localNodeId() {
    return this.swarm === 'none' ? null : (this.nodes[0]?.id ?? null);
  }

  joinInfo: SwarmJoinInfo | null = {
    workerToken: 'SWMTKN-1-worker-token',
    managerToken: 'SWMTKN-1-manager-token',
    managerAddress: '10.0.0.1:2377',
  };

  async swarmJoinInfo() {
    return this.swarm === 'manager' ? this.joinInfo : null;
  }

  async rotateJoinToken(role: 'worker' | 'manager') {
    this.calls.push(`rotate:${role}`);
    if (this.joinInfo)
      this.joinInfo = {
        ...this.joinInfo,
        [role === 'worker' ? 'workerToken' : 'managerToken']:
          `SWMTKN-1-${role}-${this.calls.length}`,
      };
  }

  async swarmJoin(opts: { token: string; remoteAddr: string }) {
    this.calls.push(`join:${opts.remoteAddr}`);
  }

  async updateNode(
    id: string,
    change: {
      availability?: 'active' | 'pause' | 'drain';
      role?: 'worker' | 'manager';
    },
  ) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new NotFoundError(`No such node ${id}`);
    this.calls.push(`node:${id}:${JSON.stringify(change)}`);
    if (change.availability) n.availability = change.availability;
    if (change.role) n.role = change.role;
  }

  async removeNode(id: string, force: boolean) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new NotFoundError(`No such node ${id}`);
    if (n.state === 'ready' && n.availability === 'active' && !force)
      throw new ConflictError('The node is still up; drain it first.');
    this.calls.push(`node-rm:${id}`);
    this.nodes = this.nodes.filter((x) => x.id !== id);
  }

  /** Which machine each service runs on, for tests; services not listed run on the first node */
  taskNodes = new Map<string, string>();

  async lastTaskNode(service: string) {
    if (!this.services.has(service)) return null;
    return this.taskNodes.get(service) ?? this.nodes[0]?.id ?? null;
  }

  async nodeTasks() {
    const first = this.nodes[0]?.id;
    return [...this.services.keys()].flatMap((service) => {
      const nodeId = this.taskNodes.get(service) ?? first;
      return nodeId ? [{ service, nodeId }] : [];
    });
  }

  async ensureNetwork(name: string, owner: { project?: string }) {
    this.calls.push(`network:${name}`);
    const found = this.networks.get(name);
    if (found) {
      if (found[LABEL_MANAGED] !== 'true')
        throw new OwnershipError(`network ${name} is not ours`);
      return;
    }
    this.networks.set(name, {
      [LABEL_MANAGED]: 'true',
      ...(owner.project ? { [LABEL_PROJECT]: owner.project } : {}),
    });
  }

  async removeNetwork(name: string, project: string) {
    const found = this.networks.get(name);
    if (!found) return false;
    if (found[LABEL_MANAGED] !== 'true' || found[LABEL_PROJECT] !== project)
      throw new OwnershipError('not ours');
    this.networks.delete(name);
    return true;
  }

  secrets = new Map<
    string,
    { value: string; labels: Record<string, string> }
  >();

  async ensureSecret(
    name: string,
    value: string,
    labels: Record<string, string>,
  ) {
    this.secrets.set(name, {
      value,
      labels: { [LABEL_MANAGED]: 'true', ...labels },
    });
    return { id: `sec-${name}`, name };
  }

  async secretIds() {
    return new Set([...this.secrets.keys()].map((n) => `sec-${n}`));
  }

  async removeSecret(name: string, app: string) {
    const s = this.secrets.get(name);
    if (!s) return false;
    if (s.labels[LABEL_MANAGED] !== 'true' || s.labels[LABEL_APP] !== app)
      throw new OwnershipError('not ours');
    this.secrets.delete(name);
    return true;
  }

  configs = new Map<string, string>();

  async ensureConfig(name: string, content: string) {
    this.configs.set(name, content);
    return { id: `cfg-${name}`, name };
  }

  async pruneConfigs(prefix: string, keep: string[]) {
    for (const n of [...this.configs.keys()])
      if (n.startsWith(prefix) && !keep.includes(n)) this.configs.delete(n);
  }

  /** Volumes a service created, with the labels Docker would have stored */
  volumes = new Map<string, Record<string, string>>();

  async listProjectVolumes(project: string) {
    return [...this.volumes]
      .filter(
        ([, l]) => l[LABEL_MANAGED] === 'true' && l[LABEL_PROJECT] === project,
      )
      .map(([n]) => n)
      .sort();
  }

  /** Mounts each service's containers have, for migration tests */
  mounts = new Map<string, ContainerMount[]>();
  /** Containers each service has left; 0 once scaled down */
  containerCounts = new Map<string, number>();
  helperRuns: HelperSpec[] = [];
  /** Open pins (id → volume and app) and the order things happened in */
  pins = new Map<string, { volume: string; app: string }>();
  events: string[] = [];
  failPin?: Error;

  async pinVolume(volume: string, _image: string, app: string) {
    if (this.failPin) throw this.failPin;
    const id = `pin-${this.pins.size + 1}-${volume.slice(0, 6)}`;
    this.pins.set(id, { volume, app });
    this.events.push(`pin:${volume.slice(0, 6)}`);
    return id;
  }

  async releasePin(id: string) {
    this.pins.delete(id);
    this.events.push(`release:${id.split('-').pop()}`);
  }

  async releasePins(app: string) {
    let n = 0;
    for (const [id, p] of [...this.pins])
      if (p.app === app) {
        this.pins.delete(id);
        n++;
      }
    return n;
  }
  helperResult: { exitCode: number; output: string } = {
    exitCode: 0,
    output: '',
  };

  /** What `serviceUsage` reports, per service: set by a test that wants a number */
  usage = new Map<string, ServiceUsage>();

  async serviceUsage(service: string) {
    if (!this.services.has(service)) return null;
    return (
      this.usage.get(service) ?? { instances: 1, cpuPercent: 0, memoryBytes: 0 }
    );
  }

  async serviceMounts(service: string) {
    return this.mounts.get(service) ?? [];
  }

  async countContainers(service: string) {
    return this.containerCounts.get(service) ?? 0;
  }

  async volumeExists(name: string) {
    return this.volumes.has(name);
  }

  async createVolume(name: string, labels: Record<string, string>) {
    if (this.volumes.has(name))
      throw new OwnershipError(`volume ${name} exists`);
    this.volumes.set(name, { [LABEL_MANAGED]: 'true', ...labels });
  }

  /** Digests a test wants services to have resolved to, by service name */
  digests = new Map<string, string>();

  async serviceImages() {
    const out: Record<string, string> = {};
    for (const [name, spec] of this.services) {
      const image = spec.TaskTemplate?.ContainerSpec?.Image;
      if (!image) continue;
      const d = this.digests.get(name);
      out[name] = d && !image.includes('@') ? `${image}@${d}` : image;
    }
    return out;
  }

  /** What `containerOwners` answers, by 12-character container id */
  owners: Record<string, string> = {};

  async containerOwners() {
    return { ...this.owners };
  }

  async runHelper(spec: HelperSpec) {
    this.helperRuns.push(spec);
    return this.helperResult;
  }

  /** What the host "has", for storage tests */
  host: {
    volumes: VolumeFact[];
    containers: ContainerFact[];
    images: ImageFact[];
  } = {
    volumes: [],
    containers: [],
    images: [],
  };
  removed: string[] = [];
  /** Names/ids Docker should refuse to remove (it is in use) */
  refuseRemoval = new Set<string>();

  async volumeFacts(withSizes: boolean) {
    return structuredClone(this.host.volumes).map((v) =>
      withSizes ? v : { ...v, sizeBytes: undefined },
    );
  }

  async storageFacts() {
    return structuredClone(this.host);
  }

  async removeVolume(name: string) {
    if (this.refuseRemoval.has(name)) throw new Error('volume is in use');
    this.removed.push(`volume:${name}`);
    this.host.volumes = this.host.volumes.filter((v) => v.name !== name);
    this.volumes.delete(name);
  }

  async removeImage(id: string) {
    if (this.refuseRemoval.has(id)) throw new Error('image is in use');
    this.removed.push(`image:${id}`);
    this.host.images = this.host.images.filter((i) => i.id !== id);
  }

  /** Lines each service's logs contain, for tests */
  logs = new Map<string, LogLine[]>();
  /** With follow, lines pushed after the call started */
  liveLogListeners = new Map<string, (l: LogLine) => void>();

  async followLogs(
    service: string,
    opts: { tail: number; follow: boolean },
    onLine: (line: LogLine) => void,
    signal: AbortSignal,
  ) {
    for (const l of (this.logs.get(service) ?? []).slice(-opts.tail)) onLine(l);
    if (!opts.follow) return;
    this.liveLogListeners.set(service, onLine);
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    this.liveLogListeners.delete(service);
  }

  /** Credentials the last applyService call carried, per service */
  appliedAuth = new Map<string, RegistryAuth | undefined>();
  /** The sign-in each service was last edited with */
  editAuth = new Map<string, RegistryAuth | undefined>();
  /** Decides whether canPull says yes; by default everything can be pulled */
  pullable: (image: string, auth?: RegistryAuth) => string | null = () => null;

  async canPull(image: string, auth?: RegistryAuth) {
    const reason = this.pullable(image, auth);
    return reason === null
      ? { ok: true as const }
      : { ok: false as const, reason };
  }

  /** Registry domains whose credentials checkRegistryAuth should reject */
  rejectRegistry = new Set<string>();

  async checkRegistryAuth(auth: RegistryAuth) {
    if (this.rejectRegistry.has(auth.serveraddress))
      throw new Error('unauthorized');
  }

  async managedObjects() {
    const managed = (l: Record<string, string> | undefined) =>
      l?.[LABEL_MANAGED] === 'true';
    return {
      services: [...this.services]
        .filter(([, s]) => managed(s.Labels))
        .map(([name, s]) => ({
          name,
          image: s.TaskTemplate?.ContainerSpec?.Image ?? '',
          labels: { ...s.Labels },
        })),
      networks: [...this.networks]
        .filter(([, l]) => managed(l))
        .map(([name, l]) => ({ name, project: l[LABEL_PROJECT] })),
      volumes: [...this.volumes]
        .filter(([, l]) => managed(l))
        .map(([name, l]) => ({ name, project: l[LABEL_PROJECT] })),
      secrets: [...this.secrets]
        .filter(([, s]) => managed(s.labels))
        .map(([name]) => name),
      configs: [...this.configs.keys()],
    };
  }

  async removeManaged(kind: ManagedKind, name: string) {
    this.calls.push(`remove-${kind}:${name}`);
    const table = {
      service: this.services,
      network: this.networks,
      volume: this.volumes,
      secret: this.secrets,
      config: this.configs,
    }[kind] as Map<string, unknown>;
    if (!table.has(name)) return false;
    const item = table.get(name) as
      | { Labels?: Record<string, string>; labels?: Record<string, string> }
      | Record<string, string>
      | string;
    const labels =
      typeof item === 'string'
        ? { [LABEL_MANAGED]: 'true' }
        : ((item as { Labels?: Record<string, string> }).Labels ??
          (item as { labels?: Record<string, string> }).labels ??
          (item as Record<string, string>));
    if (labels[LABEL_MANAGED] !== 'true') throw new OwnershipError('not ours');
    table.delete(name);
    return true;
  }

  async serviceLabels(name: string) {
    const s = this.services.get(name);
    return s ? { ...s.Labels } : null;
  }

  async editService(
    name: string,
    app: string,
    edit: (spec: SwarmServiceSpec) => SwarmServiceSpec,
    opts: { auth?: RegistryAuth } = {},
  ) {
    const existing = this.services.get(name);
    if (!existing) return false;
    if (
      existing.Labels[LABEL_MANAGED] !== 'true' ||
      existing.Labels[LABEL_APP] !== app
    )
      throw new OwnershipError(`service ${name} is not app ${app}`);
    this.calls.push(`edit:${name}`);
    this.editAuth.set(name, opts.auth);
    this.services.set(name, structuredClone(edit(structuredClone(existing))));
    return true;
  }

  /** Services whose last apply asked for a rollout even though nothing changed */
  forcedRollouts = new Set<string>();

  async applyService(
    spec: SwarmServiceSpec,
    app: string,
    auth?: RegistryAuth,
    opts: { forceRollout?: boolean } = {},
  ) {
    if (opts.forceRollout) this.forcedRollouts.add(spec.Name);
    this.appliedAuth.set(spec.Name, auth);
    this.calls.push(`apply:${spec.Name}`);
    if (this.failNextApply) {
      const e = this.failNextApply;
      this.failNextApply = undefined;
      throw e;
    }
    const existing = this.services.get(spec.Name);
    if (
      existing &&
      (existing.Labels[LABEL_MANAGED] !== 'true' ||
        existing.Labels[LABEL_APP] !== app)
    )
      throw new OwnershipError(`service ${spec.Name} is not app ${app}`);
    for (const m of spec.TaskTemplate.ContainerSpec.Mounts ?? [])
      if (m.Type === 'volume')
        // like Docker: mounting an existing volume does not change its labels
        if (!this.volumes.has(m.Source))
          this.volumes.set(m.Source, { ...(m.VolumeOptions?.Labels ?? {}) });
    this.services.set(spec.Name, structuredClone(spec));
    return existing ? ('updated' as const) : ('created' as const);
  }

  async removeService(name: string, app: string) {
    this.calls.push(`remove:${name}`);
    const existing = this.services.get(name);
    if (!existing) return false;
    if (
      existing.Labels[LABEL_MANAGED] !== 'true' ||
      existing.Labels[LABEL_APP] !== app
    )
      throw new OwnershipError('not ours');
    this.services.delete(name);
    return true;
  }

  /** The health a test wants an app's status to report, by service name */
  health = new Map<string, Health>();

  async serviceStatus(name: string): Promise<ServiceStatus | null> {
    if (this.statusOverride) return this.statusOverride(name);
    const s = this.services.get(name);
    if (!s) return null;
    const desired = s.Mode.Replicated.Replicas;
    return {
      desired,
      running: desired,
      state: desired === 0 ? 'stopped' : 'running',
      image: s.TaskTemplate.ContainerSpec.Image,
      health: this.health.get(name) ?? 'none',
    };
  }

  /** A service some other tool created, which Provelox must leave alone */
  addForeignService(name: string, labels: Record<string, string> = {}) {
    this.services.set(name, { Name: name, Labels: labels } as SwarmServiceSpec);
  }

  /** Streaming helpers started, in order */
  streamRuns: StreamHelperSpec[] = [];
  /** What the next streaming helper writes, cut into pieces of `streamChunk` bytes */
  streamBytes = Buffer.from('fake-archive-bytes');
  streamChunk = 5;
  streamExit = 0;
  streamStderr = '';
  /** Keeps the helper running until it is aborted, as a long copy would */
  streamHold = false;
  /** Make starting it fail, as Docker could not pull the image */
  streamStartError?: Error;
  streamAborts = 0;
  /** What each helper that was given input received, in order */
  streamReceived: Buffer[] = [];
  /**
   * One entry per helper started, used in order and instead of `streamBytes`/`streamExit`/`streamStderr` for that run,
   * so a test can script a listing, then a restore. When it is empty the single settings above apply.
   */
  streamPlan: { bytes?: Buffer | string; exit?: number; stderr?: string }[] =
    [];
  /** Stops reading its input after this many bytes and exits with `streamExit`, as tar does on a bad archive */
  streamInputLimit?: number;

  async streamHelper(spec: StreamHelperSpec): Promise<HelperStream> {
    this.calls.push(
      `stream-helper:${spec.mounts.map((m) => m.volume).join(',')}`,
    );
    if (this.streamStartError) throw this.streamStartError;
    this.streamRuns.push(spec);
    const plan = this.streamPlan.shift();
    const planned = plan?.bytes;
    const bytes =
      planned === undefined
        ? this.streamBytes
        : Buffer.isBuffer(planned)
          ? planned
          : Buffer.from(planned);
    const exitCode = plan?.exit ?? this.streamExit;
    const stderr = plan?.stderr ?? this.streamStderr;
    const pieces: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += this.streamChunk)
      pieces.push(bytes.subarray(i, i + this.streamChunk));
    let aborted = false;
    const hold = this.streamHold;
    // A helper with input takes the whole of it before it ends, as tar reads its archive to the end
    const input = spec.input;
    let inputDone = !input;
    let received = Buffer.alloc(0);
    const limit = this.streamInputLimit;
    if (input) {
      const finish = () => {
        inputDone = true;
        this.streamReceived.push(received);
        // a read that found nothing to hand over stays pending: start the output by hand
        step();
      };
      input.on('data', (c: Buffer) => {
        received = Buffer.concat([received, c]);
        if (limit !== undefined && received.length >= limit) {
          input.removeAllListeners('data');
          input.unpipe?.();
          finish();
        }
      });
      input.once('end', () => !inputDone && finish());
      input.once('error', () => !inputDone && finish());
    }
    const step = () => {
      const next = pieces.shift();
      if (next) stdout.push(next);
      else if (!hold) stdout.push(null);
    };
    const stdout: Readable = new Readable({
      read() {
        if (inputDone) step();
      },
    });
    const finished = new Promise<void>((resolve) =>
      stdout.once('close', resolve),
    );
    const done = finished.then(() => ({
      exitCode: aborted ? 137 : exitCode,
      stderr,
    }));
    return {
      stdout,
      done,
      abort: async () => {
        if (aborted) return;
        aborted = true;
        this.streamAborts++;
        stdout.destroy();
      },
    };
  }

  /** The running container id of a service on this machine, by service name. Empty: none here. */
  containerIds = new Map<string, string>();
  async serviceContainer(service: string) {
    return this.containerIds.get(service) ?? null;
  }

  /** Commands run inside containers, in order */
  execRuns: ExecStreamSpec[] = [];
  /** What each input the commands received was, in the same order */
  execInputs: Buffer[] = [];
  /** What the next command writes, cut into pieces of `execChunk` bytes */
  execBytes = Buffer.from('fake-dump-bytes');
  execChunk = 5;
  execExit = 0;
  execStderr = '';
  /** Keeps the command running until it is aborted, as a long dump would */
  execHold = false;
  /** Make starting it fail, as the container could not be reached */
  execStartError?: Error;
  execAborts = 0;
  /** Decides what a command does from what it is asked: its output, exit code and error text */
  execScript?: (
    spec: ExecStreamSpec,
    input: Buffer,
  ) => { out?: Buffer; exit?: number; stderr?: string } | undefined;

  async execStream(spec: ExecStreamSpec): Promise<ExecStream> {
    this.calls.push(`exec:${spec.container}`);
    if (this.execStartError) throw this.execStartError;
    this.execRuns.push(spec);
    const index = this.execInputs.length;
    this.execInputs.push(Buffer.alloc(0));
    let aborted = false;
    const hold = this.execHold;
    const self = this;
    const stdout = new Readable({ read() {} });
    let exit = 0;
    let stderr = '';
    const finish = async () => {
      const got = this.execInputs[index];
      const said = this.execScript?.(spec, got);
      const bytes = said?.out ?? this.execBytes;
      exit = said?.exit ?? this.execExit;
      stderr = said?.stderr ?? this.execStderr;
      for (let i = 0; i < bytes.length; i += this.execChunk) {
        if (aborted) break;
        stdout.push(bytes.subarray(i, i + this.execChunk));
      }
      if (!hold) stdout.push(null);
    };
    if (spec.input) {
      const parts: Buffer[] = [];
      spec.input.on('data', (c: Buffer | string) => {
        parts.push(Buffer.from(c));
        self.execInputs[index] = Buffer.concat(parts);
      });
      spec.input.once('end', () => void finish());
      spec.input.once('error', () => void finish());
    } else void Promise.resolve().then(finish);
    const closed = new Promise<void>((resolve) =>
      stdout.once('close', resolve),
    );
    const done = closed.then(() => ({
      exitCode: aborted ? 137 : exit,
      stderr,
    }));
    return {
      stdout,
      done,
      abort: async () => {
        if (aborted) return;
        aborted = true;
        this.execAborts++;
        stdout.destroy();
      },
    };
  }
}
