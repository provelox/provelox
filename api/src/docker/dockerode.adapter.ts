import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import Docker from 'dockerode';
import { CONFIG, type Config } from '../config/config';
import { NotFoundError, OwnershipError } from '../common/errors';
import { LABEL_APP, LABEL_MANAGED, LABEL_PROJECT } from '../common/naming';
import type { SwarmServiceSpec } from '../apps/service-spec';
import type {
  ContainerFact,
  ImageFact,
  VolumeFact,
} from '../storage/storage-classifier';
import { LogDemux, type LogLine } from '../utils/docker-log';
import { FrameDemux } from '../utils/docker-frames';
import { EXEC_KILL_SCRIPT } from './exec-kill';
import { serviceHealth } from './health';
import { lastDeathReason, stateFromTasks } from './task-state';
import {
  instanceUsage,
  totalUsage,
  type InstanceUsage,
  type RawStats,
  type ServiceUsage,
} from './usage';
import type {
  ContainerMount,
  DockerPort,
  ExecStream,
  ExecStreamSpec,
  HelperSpec,
  HelperStream,
  StreamHelperSpec,
  NodeInfo,
  RegistryAuth,
  ServiceStatus,
  ManagedKind,
  ManagedObjects,
} from './docker.port';

/** How long an image may take to pull before a job gives up and says so. */
const PULL_TIMEOUT_MS = 10 * 60_000;

@Injectable()
export class DockerodeAdapter implements DockerPort {
  private readonly docker: Docker;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.docker = new Docker({ socketPath: cfg.DOCKER_SOCKET });
  }

  async ping() {
    await this.docker.ping();
  }

  async swarmState() {
    const info = (await this.docker.info()) as {
      Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean };
    };
    if (info.Swarm?.LocalNodeState !== 'active') return 'none';
    return info.Swarm.ControlAvailable ? 'manager' : 'worker';
  }

  async swarmInit(advertiseAddr?: string) {
    await this.docker.swarmInit({
      ListenAddr: '0.0.0.0:2377',
      ...(advertiseAddr ? { AdvertiseAddr: advertiseAddr } : {}),
    });
  }

  async selfImage() {
    try {
      // Inside a container the hostname is the container's id, unless it was set explicitly
      const c = await this.docker.getContainer(hostname()).inspect();
      return (c.Config?.Image as string | undefined) || null;
    } catch {
      return null;
    }
  }

  /** `strict`: a Docker error is thrown instead of reading as an empty cluster (for decisions that must not guess) */
  async listNodes(strict = false): Promise<NodeInfo[]> {
    const nodes = (await this.docker
      .listNodes()
      .catch((e) => (strict ? Promise.reject(e) : []))) as {
      ID: string;
      Spec?: { Availability?: string };
      Description?: {
        Hostname?: string;
        Platform?: { OS?: string; Architecture?: string };
        Resources?: { NanoCPUs?: number; MemoryBytes?: number };
        Engine?: { EngineVersion?: string };
      };
      Status?: { State?: string; Addr?: string };
      ManagerStatus?: { Leader?: boolean };
    }[];
    // What the daemon we talk to says about its own machine; the node list cannot name the distribution
    const local = await (async () =>
      (await this.docker.info()) as {
        OperatingSystem?: string;
        KernelVersion?: string;
        Swarm?: { NodeID?: string };
      })().catch(() => null);
    const pick = <T extends string>(v: string | undefined, ok: T[], d: T) =>
      ok.includes(v as T) ? (v as T) : d;
    return nodes.map((n) => ({
      id: n.ID,
      hostname: n.Description?.Hostname ?? '',
      role: n.ManagerStatus
        ? n.ManagerStatus.Leader
          ? 'leader'
          : 'manager'
        : 'worker',
      state: pick(
        n.Status?.State,
        ['ready', 'down', 'unknown', 'disconnected'],
        'unknown',
      ),
      availability: pick(
        n.Spec?.Availability,
        ['active', 'pause', 'drain'],
        'active',
      ),
      address: n.Status?.Addr ?? '',
      cpus:
        Math.round(((n.Description?.Resources?.NanoCPUs ?? 0) / 1e9) * 100) /
        100,
      memoryBytes: n.Description?.Resources?.MemoryBytes ?? 0,
      os: n.Description?.Platform?.OS ?? '',
      architecture: n.Description?.Platform?.Architecture ?? '',
      dockerVersion: n.Description?.Engine?.EngineVersion ?? '',
      ...(local?.Swarm?.NodeID === n.ID
        ? {
            osName: local.OperatingSystem || undefined,
            kernel: local.KernelVersion || undefined,
          }
        : {}),
    }));
  }

  async localNodeId() {
    try {
      const info = (await this.docker.info()) as {
        Swarm?: { NodeID?: string; LocalNodeState?: string };
      };
      return info.Swarm?.LocalNodeState === 'active'
        ? info.Swarm.NodeID || null
        : null;
    } catch {
      return null;
    }
  }

  async swarmJoinInfo() {
    if ((await this.swarmState()) !== 'manager') return null;
    const [swarm, info] = await Promise.all([
      this.docker.swarmInspect() as Promise<{
        JoinTokens?: { Worker?: string; Manager?: string };
      }>,
      this.docker.info() as Promise<{ Swarm?: { NodeAddr?: string } }>,
    ]);
    const addr = info.Swarm?.NodeAddr;
    if (!swarm.JoinTokens?.Worker || !swarm.JoinTokens.Manager || !addr)
      return null;
    return {
      workerToken: swarm.JoinTokens.Worker,
      managerToken: swarm.JoinTokens.Manager,
      managerAddress: addr.includes(':') ? `[${addr}]:2377` : `${addr}:2377`,
    };
  }

  async rotateJoinToken(role: 'worker' | 'manager') {
    const swarm = (await this.docker.swarmInspect()) as {
      Version?: { Index?: number };
      Spec?: Record<string, unknown>;
    };
    // The update call takes the swarm's own spec as its body, and the version it was read at as a query
    await this.docker.swarmUpdate({
      _query: {
        version: swarm.Version?.Index ?? 0,
        [role === 'worker' ? 'rotateWorkerToken' : 'rotateManagerToken']: true,
      },
      _body: swarm.Spec ?? {},
    } as never);
  }

  async swarmJoin(opts: {
    token: string;
    remoteAddr: string;
    advertiseAddr?: string;
  }) {
    await this.docker.swarmJoin({
      ListenAddr: '0.0.0.0:2377',
      ...(opts.advertiseAddr ? { AdvertiseAddr: opts.advertiseAddr } : {}),
      RemoteAddrs: [opts.remoteAddr],
      JoinToken: opts.token,
    } as never);
  }

  async updateNode(
    id: string,
    change: {
      availability?: 'active' | 'pause' | 'drain';
      role?: 'worker' | 'manager';
    },
  ) {
    const node = this.docker.getNode(id);
    const current = (await node.inspect()) as {
      Version?: { Index?: number };
      Spec?: Record<string, unknown>;
    };
    await node.update({
      _query: { version: current.Version?.Index ?? 0 },
      _body: {
        ...(current.Spec ?? {}),
        ...(change.availability ? { Availability: change.availability } : {}),
        ...(change.role ? { Role: change.role } : {}),
      },
    } as never);
  }

  async removeNode(id: string, force: boolean) {
    await this.docker.getNode(id).remove({ force } as never);
  }

  async lastTaskNode(service: string) {
    const tasks = (await this.docker.listTasks({
      filters: { service: [service] },
    })) as { NodeID?: string; CreatedAt?: string }[];
    const placed = tasks
      .filter((t) => t.NodeID)
      .sort((a, b) => (b.CreatedAt ?? '').localeCompare(a.CreatedAt ?? ''));
    return placed[0]?.NodeID ?? null;
  }

  async nodeTasks() {
    const [services, tasks] = await Promise.all([
      this.docker.listServices(),
      this.docker.listTasks({ filters: { 'desired-state': ['running'] } }),
    ]);
    const names = new Map(
      (services as { ID: string; Spec?: { Name?: string } }[]).map((s) => [
        s.ID,
        s.Spec?.Name ?? '',
      ]),
    );
    return (
      tasks as {
        ServiceID?: string;
        NodeID?: string;
        Status?: { State?: string };
      }[]
    )
      .filter((t) => t.NodeID && t.Status?.State === 'running')
      .map((t) => ({
        service: names.get(t.ServiceID ?? '') ?? '',
        nodeId: t.NodeID as string,
      }))
      .filter((t) => t.service);
  }

  async ensureNetwork(name: string, owner: { project?: string }) {
    const found = (
      await this.docker.listNetworks({ filters: { name: [name] } })
    ).find((n) => n.Name === name);
    if (found) {
      // A network with our name that we did not create is someone else's: refuse rather than attach to it
      if (found.Labels?.[LABEL_MANAGED] !== 'true')
        throw new OwnershipError(
          `A Docker network named "${name}" already exists and is not managed by Provelox.`,
        );
      return;
    }
    await this.docker.createNetwork({
      Name: name,
      Driver: 'overlay',
      Attachable: true,
      // Between machines the overlay's traffic is plain unless asked otherwise: encrypt it, so a cluster can span
      // networks that are not private
      Options: { encrypted: 'true' },
      Labels: {
        [LABEL_MANAGED]: 'true',
        ...(owner.project ? { [LABEL_PROJECT]: owner.project } : {}),
      },
    });
  }

  async unencryptedNetworks() {
    const nets = (await this.docker.listNetworks()) as {
      Name: string;
      Driver?: string;
      Options?: Record<string, string>;
      Labels?: Record<string, string>;
    }[];
    return nets
      .filter(
        (n) =>
          n.Driver === 'overlay' &&
          n.Labels?.[LABEL_MANAGED] === 'true' &&
          n.Options?.encrypted === undefined,
      )
      .map((n) => n.Name);
  }

  async encryptNetwork(name: string) {
    // Each service's original networks are written onto the service itself before it is taken off, so a run that is
    // interrupted (or fails) can be finished by running the command again
    const KEPT = 'io.provelox.reattach';
    type Net = {
      Id: string;
      Name: string;
      Labels?: Record<string, string>;
      Options?: Record<string, string>;
      IPAM?: unknown;
      Driver?: string;
    };
    type Attach = { Target: string; Aliases?: string[] };
    type Svc = {
      ID: string;
      Spec: {
        Name: string;
        Labels?: Record<string, string>;
        TaskTemplate: { Networks?: Attach[] } & Record<string, unknown>;
      } & Record<string, unknown>;
      Version?: { Index?: number };
    };
    const find = async () =>
      (
        (await this.docker.listNetworks({
          filters: { name: [name] },
        })) as Net[]
      ).find((n) => n.Name === name);
    const net = await find();
    const all = (await this.docker.listServices()) as unknown as Svc[];
    const interrupted = all.filter((s) => s.Spec.Labels?.[KEPT]);
    if (!net && interrupted.length === 0)
      throw new NotFoundError(`There is no network named "${name}".`);
    if (
      net &&
      (net.Labels?.[LABEL_MANAGED] !== 'true' || net.Driver !== 'overlay')
    )
      throw new OwnershipError(
        `"${name}" is not an overlay network Provelox made, so it was left alone.`,
      );
    if (net && net.Options?.encrypted !== undefined && interrupted.length === 0)
      return { services: [] };

    const onNetwork = (s: Svc) =>
      (s.Spec.TaskTemplate.Networks ?? []).some(
        (a) => a.Target === net?.Id || a.Target === name,
      );
    // Docker wants the version it last saw, so read the service again before each change
    const rewrite = async (id: string, change: (spec: Svc['Spec']) => void) => {
      const svc = this.docker.getService(id);
      const cur = (await svc.inspect()) as Svc;
      const spec = structuredClone(cur.Spec);
      change(spec);
      await svc.update({
        _query: { version: cur.Version?.Index ?? 0 },
        _body: spec,
      } as never);
    };
    const moved = new Set<string>(interrupted.map((s) => s.Spec.Name));

    // 1. note each service's networks on the service, and take it off this network
    if (net && net.Options?.encrypted === undefined) {
      for (const s of all.filter(
        (x) => !x.Spec.Labels?.[KEPT] && onNetwork(x),
      )) {
        await rewrite(s.ID, (spec) => {
          const original = spec.TaskTemplate.Networks ?? [];
          spec.Labels = {
            ...(spec.Labels ?? {}),
            [KEPT]: JSON.stringify(original),
          };
          spec.TaskTemplate.Networks = original.filter(
            (a) => a.Target !== net.Id && a.Target !== name,
          );
        });
        moved.add(s.Spec.Name);
      }
    }

    // Puts every noted service back on whatever network of this name exists now
    const reattach = async (target: string, replaces: string[]) => {
      const left = (await this.docker.listServices()) as unknown as Svc[];
      for (const s of left.filter((x) => x.Spec.Labels?.[KEPT])) {
        await rewrite(s.ID, (spec) => {
          const original = JSON.parse(spec.Labels?.[KEPT] ?? '[]') as Attach[];
          spec.TaskTemplate.Networks = original.map((a) =>
            replaces.includes(a.Target) ? { ...a, Target: target } : a,
          );
          delete spec.Labels?.[KEPT];
        });
      }
    };

    // 2. remove the old network once its last task has let go
    if (net && net.Options?.encrypted === undefined) {
      let removed = false;
      let lastError: unknown;
      for (let i = 0; i < 30 && !removed; i++) {
        try {
          await this.docker.getNetwork(net.Id).remove();
          removed = true;
        } catch (e) {
          lastError = e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!removed) {
        // it would not go: put everything back where it was, and say so
        await reattach(net.Id, [net.Id, name]);
        throw lastError instanceof Error
          ? lastError
          : new Error(`The network ${name} could not be removed.`);
      }
    }

    // 3. an encrypted network of this name: one that something else already made (the API recreates it on its own), or
    // a new one with the old one's labels and address range
    let current = await find();
    if (!current || current.Options?.encrypted === undefined) {
      const made = (await this.docker.createNetwork({
        Name: name,
        Driver: 'overlay',
        Attachable: true,
        Options: { encrypted: 'true' },
        Labels: net?.Labels ?? { [LABEL_MANAGED]: 'true' },
        ...(net?.IPAM ? { IPAM: net.IPAM } : {}),
      } as never)) as { id?: string };
      current = (await find()) ?? ({ Id: made.id ?? name } as Net);
    }

    // 4. put each service back as it was
    await reattach(current.Id, [net?.Id ?? '', name]);
    return { services: [...moved] };
  }

  async removeNetwork(name: string, project: string) {
    const found = (
      await this.docker.listNetworks({ filters: { name: [name] } })
    ).find((n) => n.Name === name);
    if (!found) return false;
    if (
      found.Labels?.[LABEL_MANAGED] !== 'true' ||
      found.Labels?.[LABEL_PROJECT] !== project
    )
      throw new OwnershipError(
        `Network "${name}" does not belong to project "${project}", so it was left alone.`,
      );
    await this.docker.getNetwork(found.Id).remove();
    return true;
  }

  private async find(name: string) {
    const list = await this.docker.listServices({ filters: { name: [name] } });
    return list.find((s) => s.Spec?.Name === name);
  }

  private assertOwned(found: Docker.Service | any, app: string) {
    const labels = found.Spec?.Labels ?? {};
    if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_APP] !== app)
      throw new OwnershipError(
        `A Docker service named "${found.Spec?.Name}" exists but is not the Provelox app "${app}", so it was left alone.`,
      );
  }

  async listProjectVolumes(project: string) {
    const res = await this.docker.listVolumes({
      filters: {
        label: [`${LABEL_MANAGED}=true`, `${LABEL_PROJECT}=${project}`],
      },
    });
    return (res.Volumes ?? []).map((v) => v.Name).sort();
  }

  async secretIds() {
    return new Set((await this.docker.listSecrets()).map((s) => s.ID));
  }

  async ensureSecret(
    name: string,
    value: string,
    labels: Record<string, string>,
  ) {
    const found = (
      await this.docker.listSecrets({ filters: { name: [name] } })
    ).find((s) => s.Spec?.Name === name);
    if (found) {
      if (found.Spec?.Labels?.[LABEL_MANAGED] !== 'true')
        throw new OwnershipError(
          `A Docker secret named "${name}" exists and is not managed by Provelox.`,
        );
      return { id: found.ID, name };
    }
    const created = await this.docker.createSecret({
      Name: name,
      Labels: { [LABEL_MANAGED]: 'true', ...labels },
      Data: Buffer.from(value).toString('base64'),
    } as never);
    return {
      id:
        (created as { ID?: string; id?: string }).ID ??
        (created as { id: string }).id,
      name,
    };
  }

  async removeSecret(name: string, app: string) {
    const found = (
      await this.docker.listSecrets({ filters: { name: [name] } })
    ).find((s) => s.Spec?.Name === name);
    if (!found) return false;
    const labels = found.Spec?.Labels ?? {};
    if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_APP] !== app)
      throw new OwnershipError(
        `Secret "${name}" does not belong to the app "${app}", so it was left alone.`,
      );
    await this.docker.getSecret(found.ID).remove();
    return true;
  }

  async ensureConfig(
    name: string,
    content: string,
    labels: Record<string, string>,
  ) {
    const found = (
      await this.docker.listConfigs({ filters: { name: [name] } })
    ).find((c) => c.Spec?.Name === name);
    if (found) {
      if (found.Spec?.Labels?.[LABEL_MANAGED] !== 'true')
        throw new OwnershipError(
          `A Docker config named "${name}" exists and is not managed by Provelox.`,
        );
      return { id: found.ID, name };
    }
    const created = await this.docker.createConfig({
      Name: name,
      Labels: { [LABEL_MANAGED]: 'true', ...labels },
      Data: Buffer.from(content).toString('base64'),
    } as never);
    return {
      id:
        (created as { ID?: string; id?: string }).ID ??
        (created as { id: string }).id,
      name,
    };
  }

  async pruneConfigs(prefix: string, keep: string[]) {
    const all = await this.docker.listConfigs({
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    for (const c of all) {
      const n = c.Spec?.Name ?? '';
      if (!n.startsWith(prefix) || keep.includes(n)) continue;
      try {
        await this.docker.getConfig(c.ID).remove();
      } catch {
        // still used by a service that has not been updated yet: next prune
      }
    }
  }

  async followLogs(
    service: string,
    opts: { tail: number; follow: boolean },
    onLine: (line: LogLine) => void,
    signal: AbortSignal,
  ) {
    const found = await this.find(service);
    if (!found) return;
    const demux = new LogDemux();
    const emit = (lines: LogLine[]) => lines.forEach(onLine);
    const res: unknown = await this.docker.getService(found.ID).logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: opts.tail,
      follow: opts.follow,
    } as never);
    if (Buffer.isBuffer(res)) {
      emit(demux.push(res));
      emit(demux.end());
      return;
    }
    const stream = res as NodeJS.ReadableStream & { destroy?: () => void };
    await new Promise<void>((resolve) => {
      const stop = () => {
        stream.destroy?.();
        resolve();
      };
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      stream.on('data', (c: Buffer) => emit(demux.push(c)));
      stream.on('end', () => {
        emit(demux.end());
        resolve();
      });
      stream.on('error', () => resolve());
      stream.on('close', () => resolve());
    });
  }

  async volumeFacts(withSizes: boolean): Promise<VolumeFact[]> {
    const list = await this.docker.listVolumes();
    const sizes = new Map<string, number>();
    if (withSizes) {
      // df has volume sizes, which a plain volume listing does not
      const df = (await this.docker.df()) as {
        Volumes?: { Name: string; UsageData?: { Size?: number } }[];
      };
      for (const v of df.Volumes ?? [])
        if ((v.UsageData?.Size ?? -1) >= 0)
          sizes.set(v.Name, v.UsageData?.Size as number);
    }
    return (list.Volumes ?? []).map((v) => ({
      name: v.Name,
      labels: (v.Labels as Record<string, string> | null) ?? {},
      mountpoint: v.Mountpoint,
      createdAt: (v as { CreatedAt?: string }).CreatedAt,
      sizeBytes: sizes.get(v.Name),
    }));
  }

  async storageFacts() {
    const [volumes, containers, images] = await Promise.all([
      this.volumeFacts(true),
      this.docker.listContainers({ all: true }),
      this.docker.listImages(),
    ]);
    const facts: ContainerFact[] = containers.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
      imageId: c.ImageID,
      imageName: c.Image,
      service: c.Labels?.['com.docker.swarm.service.name'],
      mounts: (c.Mounts ?? []).map((m) => ({ type: m.Type, name: m.Name })),
    }));
    const imgs: ImageFact[] = images.map((i) => ({
      id: i.Id,
      tags: (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>'),
      sizeBytes: i.Size,
      createdAt: i.Created,
    }));
    return { volumes, containers: facts, images: imgs };
  }

  async removeVolume(name: string) {
    await this.docker.getVolume(name).remove();
  }

  async removeImage(id: string) {
    await this.docker.getImage(id).remove();
  }

  async serviceMounts(service: string) {
    const containers = await this.docker.listContainers({
      all: false,
      filters: { label: [`com.docker.swarm.service.name=${service}`] },
    });
    const seen = new Map<string, ContainerMount>();
    for (const c of containers)
      for (const m of c.Mounts ?? [])
        seen.set(`${m.Destination}`, {
          type: m.Type,
          name: m.Name,
          destination: m.Destination,
          readOnly: m.RW === false,
        });
    return [...seen.values()];
  }

  async serviceUsage(service: string): Promise<ServiceUsage | null> {
    const list = await this.docker.listContainers({
      all: false,
      filters: { label: [`com.docker.swarm.service.name=${service}`] },
    });
    // Only the instances on this machine can be read: Docker's stats are per host
    const parts = await Promise.all(
      list.map(async (c) => {
        try {
          const raw = await this.docker
            .getContainer(c.Id)
            .stats({ stream: false });
          return instanceUsage(raw as RawStats);
        } catch {
          return null; // it stopped between the list and the sample
        }
      }),
    );
    return totalUsage(parts.filter((p): p is InstanceUsage => p !== null));
  }

  /**
   * Containers of the service that are still alive. Exited ones do not count: Swarm keeps a few of them as task
   * history, and they cannot write to a volume.
   */
  async countContainers(service: string) {
    const list = await this.docker.listContainers({
      all: false,
      filters: { label: [`com.docker.swarm.service.name=${service}`] },
    });
    return list.length;
  }

  async volumeExists(name: string) {
    const res = await this.docker.listVolumes({ filters: { name: [name] } });
    return (res.Volumes ?? []).some((v) => v.Name === name);
  }

  async createVolume(name: string, labels: Record<string, string>) {
    if (await this.volumeExists(name))
      throw new OwnershipError(
        `A Docker volume named "${name}" already exists.`,
      );
    await this.docker.createVolume({
      Name: name,
      Labels: { [LABEL_MANAGED]: 'true', ...labels },
    });
  }

  /** `docker run` pulls a missing image on its own; the API does not, so do it here. */
  private async ensureImage(image: string) {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // not present: pull below
    }
    const stream = await this.docker.pull(image);
    const pulled = new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      ),
    );
    // A registry that does not answer would otherwise leave this waiting for ever, with nothing on the screen
    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Could not pull ${image} within ${PULL_TIMEOUT_MS / 60_000} minutes. Is its registry reachable from this server? Pull it yourself (docker pull ${image}), or name an image that is already here.`,
            ),
          ),
        PULL_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([pulled, tooSlow]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Makes an image available (pulling it when it is not here), so a long job does not find out halfway that it cannot. */
  async prepareImage(image: string) {
    await this.ensureImage(image);
  }

  /**
   * Removes copy helpers an earlier run left behind (its command was cut off, say by a dropped connection). One still
   * running would go on writing to the volume a new run is about to empty.
   */
  private async removeStaleHelpers() {
    const stale = await this.docker.listContainers({
      all: true,
      filters: { label: ['io.provelox.helper=true'] },
    });
    for (const c of stale)
      await this.docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => undefined);
  }

  async pinVolume(volume: string, image: string, app: string) {
    await this.ensureImage(image);
    const c = await this.docker.createContainer({
      Image: image,
      Cmd: ['sleep', '31536000'],
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_APP]: app,
        'io.provelox.helper': 'pin',
      },
      HostConfig: {
        Binds: [`${volume}:/pinned:ro`],
        NetworkMode: 'none',
        // survives a Docker restart, so a held volume stays held
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await c.start();
    return c.id;
  }

  async releasePin(id: string) {
    await this.docker.getContainer(id).remove({ force: true });
  }

  async releasePins(app: string) {
    const pins = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          `${LABEL_MANAGED}=true`,
          `${LABEL_APP}=${app}`,
          'io.provelox.helper=pin',
        ],
      },
    });
    for (const p of pins)
      await this.docker.getContainer(p.Id).remove({ force: true });
    return pins.length;
  }

  async runHelper(spec: HelperSpec) {
    await this.ensureImage(spec.image);
    await this.removeStaleHelpers();
    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: spec.command,
      ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
      Labels: { [LABEL_MANAGED]: 'true', 'io.provelox.helper': 'true' },
      HostConfig: {
        // by name, so Docker binds the exact volume and nothing is created implicitly
        Binds: [
          ...spec.mounts.map(
            (m) => `${m.volume}:${m.target}${m.readOnly ? ':ro' : ''}`,
          ),
          ...(spec.hostPid && spec.hostRoot ? ['/:/host:ro'] : []),
        ],
        NetworkMode: 'none',
        ...(spec.hostPid
          ? {
              PidMode: 'host',
              ReadonlyRootfs: true,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges'],
              Memory: 128 * 1024 * 1024,
              // Reading other users' files and /proc/<pid>/exe, which no capability-less root may do. Neither can write.
              ...(spec.hostRoot
                ? { CapAdd: ['DAC_READ_SEARCH', 'SYS_PTRACE'] }
                : {}),
            }
          : {}),
      },
    });
    try {
      await container.start();
      const { StatusCode } = await container.wait();
      // Only the end is used (a comparison of a big live volume can list a great many files): ask Docker for just that
      const logs = (await container.logs({
        stdout: true,
        stderr: true,
        tail: 2000,
      })) as Buffer;
      // The logs of a container without a TTY are framed (8-byte headers): parse them, do not print them
      const demux = new LogDemux();
      const lines = [...demux.push(Buffer.from(logs)), ...demux.end()];
      const output = lines.map((l) => l.text).join('\n');
      return {
        exitCode: StatusCode,
        output: output.slice(-(spec.maxOutput ?? 4000)),
      };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async serviceImages() {
    const services = await this.docker.listServices();
    const out: Record<string, string> = {};
    for (const s of services) {
      const name = s.Spec?.Name;
      const image = (s.Spec?.TaskTemplate as any)?.ContainerSpec?.Image as
        string | undefined;
      if (name && image) out[name] = image;
    }
    return out;
  }

  async containerOwners() {
    const containers = await this.docker.listContainers({ all: false });
    return Object.fromEntries(
      containers.map((c) => [
        c.Id.slice(0, 12),
        c.Labels?.['com.docker.swarm.service.name'] ??
          (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
      ]),
    );
  }

  async checkRegistryAuth(auth: RegistryAuth) {
    await this.docker.checkAuth(auth);
  }

  async applyService(
    spec: SwarmServiceSpec,
    app: string,
    auth?: RegistryAuth,
    opts: { forceRollout?: boolean } = {},
  ) {
    const found = await this.find(spec.Name);
    if (!found) {
      if (auth) await this.docker.createService(auth as never, spec as never);
      else await this.docker.createService(spec as never);
      return 'created';
    }
    this.assertOwned(found, app);
    // Docker needs the version it last saw, and rejects the update if someone changed the service in between
    const version = found.Version?.Index;
    if (version === undefined)
      throw new Error(
        `Docker did not report a version for service "${spec.Name}".`,
      );
    if (opts.forceRollout) {
      const previous = Number(
        (found.Spec?.TaskTemplate as { ForceUpdate?: number } | undefined)
          ?.ForceUpdate ?? 0,
      );
      spec = {
        ...spec,
        TaskTemplate: { ...spec.TaskTemplate, ForceUpdate: previous + 1 },
      };
    }
    await this.docker.getService(found.ID).update({
      ...(spec as any),
      version,
      ...(auth ? { authconfig: auth } : {}),
    });
    return 'updated';
  }

  async serviceLabels(name: string) {
    const found = await this.find(name);
    return found ? { ...(found.Spec?.Labels ?? {}) } : null;
  }

  async editService(
    name: string,
    app: string,
    edit: (spec: SwarmServiceSpec) => SwarmServiceSpec,
    opts: { auth?: RegistryAuth } = {},
  ) {
    const found = await this.find(name);
    if (!found) return false;
    this.assertOwned(found, app);
    const version = found.Version?.Index;
    if (version === undefined)
      throw new Error(`Docker did not report a version for service "${name}".`);
    const next = edit(
      structuredClone(found.Spec) as unknown as SwarmServiceSpec,
    );
    // The spec is the body and only the version is in the address (with the whole spec in the address, as applyService
    // does, a sign-in would end up in it too). A service Docker has never updated has no "previous spec" to take a
    // sign-in from, so none is asked for: Docker keeps the service's own, and `opts.auth` replaces it.
    await this.docker.getService(found.ID).update({
      _query: { version },
      _body: next,
      ...(opts.auth ? { authconfig: opts.auth } : {}),
    } as never);
    return true;
  }

  async canPull(image: string, auth?: RegistryAuth) {
    try {
      await new Promise<void>((resolve, reject) =>
        this.docker.modem.dial(
          {
            path: `/distribution/${encodeURI(image)}/json`,
            method: 'GET',
            ...(auth ? { authconfig: auth } : {}),
            statusCodes: {
              200: true,
              401: 'unauthorized',
              403: 'forbidden',
              404: 'not found',
              500: 'server error',
            },
          },
          (err: unknown) => (err ? reject(err) : resolve()),
        ),
      );
      return { ok: true as const };
    } catch (e) {
      // Docker puts the registry's words in the body's message
      const msg =
        (e as { json?: { message?: string } }).json?.message ??
        (e as Error).message ??
        String(e);
      return {
        ok: false as const,
        reason: msg.replace(/^\(HTTP code \d+\) [^-]*- /, ''),
      };
    }
  }

  async removeService(name: string, app: string) {
    const found = await this.find(name);
    if (!found) return false;
    this.assertOwned(found, app);
    await this.docker.getService(found.ID).remove();
    return true;
  }

  async managedObjects(): Promise<ManagedObjects> {
    const filters = { label: [`${LABEL_MANAGED}=true`] };
    const [services, networks, volumes, secrets, configs] = await Promise.all([
      this.docker.listServices({ filters }),
      this.docker.listNetworks({ filters }),
      this.docker.listVolumes({ filters }),
      this.docker.listSecrets({ filters }),
      this.docker.listConfigs({ filters }),
    ]);
    return {
      services: services.map((s) => ({
        name: s.Spec?.Name ?? '',
        image: (
          (s.Spec?.TaskTemplate as { ContainerSpec?: { Image?: string } })
            ?.ContainerSpec?.Image ?? ''
        ).split('@')[0],
        labels: s.Spec?.Labels ?? {},
      })),
      networks: networks.map((n) => ({
        name: n.Name,
        project: n.Labels?.[LABEL_PROJECT],
      })),
      volumes: (volumes.Volumes ?? []).map((v) => ({
        name: v.Name,
        project: v.Labels?.[LABEL_PROJECT],
      })),
      secrets: secrets.map((s) => s.Spec?.Name ?? ''),
      configs: configs.map((c) => c.Spec?.Name ?? ''),
    };
  }

  async removeManaged(kind: ManagedKind, name: string) {
    const ours = (labels: Record<string, string> | undefined) => {
      if (labels?.[LABEL_MANAGED] !== 'true')
        throw new OwnershipError(
          `${kind} "${name}" was not made by Provelox, so it was left alone.`,
        );
    };
    if (kind === 'service') {
      const found = await this.find(name);
      if (!found) return false;
      ours(found.Spec?.Labels);
      await this.docker.getService(found.ID).remove();
    } else if (kind === 'network') {
      const found = (
        await this.docker.listNetworks({ filters: { name: [name] } })
      ).find((n) => n.Name === name);
      if (!found) return false;
      ours(found.Labels);
      await this.docker.getNetwork(found.Id).remove();
    } else if (kind === 'volume') {
      const found = (await this.docker.listVolumes()).Volumes?.find(
        (v) => v.Name === name,
      );
      if (!found) return false;
      ours(found.Labels);
      await this.docker.getVolume(name).remove();
    } else if (kind === 'secret') {
      const found = (
        await this.docker.listSecrets({ filters: { name: [name] } })
      ).find((s) => s.Spec?.Name === name);
      if (!found) return false;
      ours(found.Spec?.Labels);
      await this.docker.getSecret(found.ID).remove();
    } else {
      const found = (
        await this.docker.listConfigs({ filters: { name: [name] } })
      ).find((c) => c.Spec?.Name === name);
      if (!found) return false;
      ours(found.Spec?.Labels);
      await this.docker.getConfig(found.ID).remove();
    }
    return true;
  }

  async serviceStatus(name: string): Promise<ServiceStatus | null> {
    const found = await this.find(name);
    if (!found) return null;
    const desired = found.Spec?.Mode?.Replicated?.Replicas ?? 0;
    const tasks = await this.docker.listTasks({ filters: { service: [name] } });
    const current = tasks.filter((t) => t.DesiredState === 'running');
    const running = current.filter((t) => t.Status?.State === 'running').length;
    const image = (found.Spec?.TaskTemplate as any)?.ContainerSpec?.Image as
      string | undefined;

    // Health shows in the status line of each running container: one list call, no inspect per container
    const containers = desired
      ? await this.docker.listContainers({
          all: false,
          filters: { label: [`com.docker.swarm.service.name=${name}`] },
        })
      : [];
    const health = serviceHealth(containers.map((c) => c.Status ?? ''));

    const { state, message: failing } = stateFromTasks(desired, running, tasks);
    const updateState = (found as any).UpdateStatus?.State as
      string | undefined;
    // A rolled-back update leaves the old version running, so the reason it was rolled back is in the dead task
    const message = updateState?.startsWith('rollback')
      ? (lastDeathReason(tasks) ?? failing)
      : failing;
    return {
      desired,
      running,
      state,
      updateState,
      message,
      image: image?.split('@')[0],
      health,
    };
  }

  /** Copy helpers (download or restore) that finished or died (the API was stopped mid-copy): none is wanted any more */
  private async removeFinishedDownloads(kind = 'download') {
    const old = await this.docker.listContainers({
      all: true,
      filters: { label: [`io.provelox.helper=${kind}`] },
    });
    for (const c of old)
      if (c.State !== 'running')
        await this.docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => undefined);
  }

  async streamHelper(spec: StreamHelperSpec): Promise<HelperStream> {
    await this.ensureImage(spec.image);
    const kind = spec.kind ?? 'download';
    await this.removeFinishedDownloads(kind);
    const input = spec.input;
    const container = await this.docker.createContainer({
      Image: spec.image,
      Entrypoint: spec.entrypoint,
      Cmd: spec.command,
      Tty: false,
      // Standard input is opened once, and closed when the archive has been written (a restore reads it)
      OpenStdin: !!input,
      StdinOnce: !!input,
      AttachStdin: !!input,
      AttachStdout: true,
      AttachStderr: true,
      // Not 'true': the other helpers remove every container with that label before they run, which would kill a copy
      Labels: { [LABEL_MANAGED]: 'true', 'io.provelox.helper': kind },
      HostConfig: {
        Binds: spec.mounts.map(
          (m) => `${m.volume}:${m.target}${m.readOnly ? ':ro' : ''}`,
        ),
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        // It only reads, but must read files whatever their owner and mode are, or a database's private files are skipped
        CapDrop: ['ALL'],
        CapAdd: spec.capabilities ?? ['DAC_READ_SEARCH'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 256 * 1024 * 1024,
        PidsLimit: 64,
      },
    });
    const remove = () =>
      container.remove({ force: true }).catch(() => undefined);
    try {
      const raw = (await container.attach({
        stream: true,
        stdin: !!input,
        stdout: true,
        stderr: true,
        hijack: !!input,
      })) as NodeJS.ReadableStream & {
        destroy?: () => void;
        end?: () => void;
        on(e: 'error', f: (err: Error) => void): unknown;
      };
      // The program may exit (tar rejecting the archive) while the upload is still arriving: a write to it is then moot
      raw.on('error', () => undefined);
      const out = new FrameDemux();
      raw.pipe(out);
      await container.start();
      // Written only once it runs; the end of the input closes standard input, which is how tar knows the archive is over
      if (input)
        (input as NodeJS.ReadableStream).pipe(
          raw as unknown as NodeJS.WritableStream,
        );
      const exited = container
        .wait()
        .then((r) => r.StatusCode)
        .catch(() => -1);
      // Once the program is gone nothing more can be written to it: let go of the upload
      void exited.then(() =>
        input?.unpipe?.(raw as unknown as NodeJS.WritableStream),
      );
      // Closes when everything has been read, or when the reader gave up and the stream was destroyed
      const drained = new Promise<void>((resolve) => {
        out.once('close', () => resolve());
      });
      const done = Promise.all([exited, drained]).then(async ([exitCode]) => {
        await remove();
        return { exitCode, stderr: out.stderr };
      });
      let aborted = false;
      return {
        stdout: out,
        done,
        abort: async () => {
          if (aborted) return;
          aborted = true;
          input?.unpipe?.();
          raw.unpipe(out);
          raw.destroy?.();
          out.destroy();
          // killed first, so tar stops reading the volume at once; removal alone would wait for it
          await container.kill().catch(() => undefined);
          await remove();
        },
      };
    } catch (e) {
      await remove();
      throw e;
    }
  }

  async serviceContainer(service: string) {
    const list = await this.docker.listContainers({
      all: false,
      filters: {
        label: [`com.docker.swarm.service.name=${service}`],
        status: ['running'],
      },
    });
    return list[0]?.Id ?? null;
  }

  async execStream(spec: ExecStreamSpec): Promise<ExecStream> {
    const container = this.docker.getContainer(spec.container);
    // Marks the processes of this exec, so they can be found and stopped inside the container if the reader goes away
    const marker = randomUUID();
    const exec = await container.exec({
      Cmd: spec.cmd,
      Env: [`PVX_EXEC=${marker}`],
      AttachStdin: !!spec.input,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const raw = (await exec.start({
      hijack: !!spec.input,
      stdin: !!spec.input,
    })) as NodeJS.ReadWriteStream & { destroy?: () => void };
    const out = new FrameDemux();
    raw.pipe(out);
    // Everything the person sent is written to the program, and its input closed at the end, so it sees the end of the file
    if (spec.input) {
      spec.input.on('error', () => raw.end());
      spec.input.pipe(raw);
    }
    const drained = new Promise<void>((resolve) => {
      out.once('close', () => resolve());
    });
    const done = drained.then(async () => {
      // The exit code is known a moment after the streams close
      for (let i = 0; i < 100; i++) {
        const info = await exec.inspect().catch(() => null);
        if (info && !info.Running)
          return { exitCode: info.ExitCode ?? -1, stderr: out.stderr };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { exitCode: -1, stderr: out.stderr };
    });
    let aborted = false;
    return {
      stdout: out,
      done,
      abort: async () => {
        if (aborted) return;
        aborted = true;
        (spec.input as { unpipe?: (d: unknown) => void } | undefined)?.unpipe?.(
          raw,
        );
        raw.destroy?.();
        out.destroy();
        // The connection closing ends most programs at their next read or write; this makes sure of the rest
        try {
          const killer = await container.exec({
            Cmd: ['sh', '-c', EXEC_KILL_SCRIPT, 'sh', marker],
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
          });
          const k = await killer.start({});
          k.on('data', () => undefined);
          await new Promise<void>((resolve) => {
            k.once('end', () => resolve());
            k.once('close', () => resolve());
            k.once('error', () => resolve());
          });
        } catch {
          // the container is gone, so is the program
        }
      },
    };
  }
}
