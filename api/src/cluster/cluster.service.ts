import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { AppsService } from '../apps/apps.service';
import { DOCKER, type DockerPort, type NodeInfo } from '../docker/docker.port';
import { PLATFORM_SERVICES } from '../system/platform-usage.service';

export type Availability = 'active' | 'pause' | 'drain';
export type NodeRole = 'worker' | 'manager';

/** What runs on a machine: an app or one of the platform's own services, and how many instances of it. */
export interface Workload {
  name: string;
  kind: 'app' | 'platform';
  count: number;
  /** An app held to this machine because its data is here: it cannot run anywhere else */
  pinned?: boolean;
}

export interface ClusterNode extends NodeInfo {
  /** The machine this API talks to: it cannot be demoted or removed from here */
  isLocal: boolean;
  workloads: Workload[];
}

export interface ClusterOverview {
  nodes: ClusterNode[];
  managers: number;
  /** Things worth knowing about the cluster as it is now, in plain words */
  warnings: string[];
  /** This host is a Swarm manager, so machines can be joined to it */
  canJoin: boolean;
  /**
   * When the apps network is not encrypted and there is more than one machine: the command that fixes it. It has to run
   * outside the API (which is on that network and would be cut off from its own change), so it is a command to copy.
   */
  encryptCommand: string | null;
}

export interface JoinRole {
  token: string;
  /** For the machine that is joining: Docker's own command */
  swarmCommand: string;
  /** The same through Provelox, which also checks the machine can reach this one first */
  proveloxCommand: string;
}

export interface JoinInstructions {
  managerAddress: string;
  /** The image the join command runs: the one this platform runs */
  image: string;
  worker: JoinRole;
  manager: JoinRole;
  ports: string[];
}

const PLATFORM = new Map<string, string>(
  PLATFORM_SERVICES.map((s) => [s.service, s.label]),
);

/** Machines in the Swarm: who they are, what runs on them, how another joins, and how one is taken out of service. */
@Injectable()
export class ClusterService {
  constructor(
    @Inject(DOCKER) private readonly docker: DockerPort,
    private readonly apps: AppsService,
  ) {}

  async overview(): Promise<ClusterOverview> {
    const [nodes, local, tasks, state, plain] = await Promise.all([
      this.docker.listNodes(),
      this.docker.localNodeId(),
      this.docker.nodeTasks().catch(() => []),
      this.docker.swarmState(),
      this.docker.unencryptedNetworks().catch(() => []),
    ]);
    const on = new Map<string, Map<string, number>>();
    for (const t of tasks) {
      const m = on.get(t.nodeId) ?? new Map<string, number>();
      m.set(t.service, (m.get(t.service) ?? 0) + 1);
      on.set(t.nodeId, m);
    }
    // A cluster that has grown holds each app with local data to its machine before anything can move it
    const unresolved =
      state === 'manager' && nodes.length > 1
        ? await this.apps.pinVolumeApps().catch(() => [])
        : [];
    const out: ClusterNode[] = nodes.map((n) => {
      const pinned = new Set(this.apps.pinnedApps(n.id));
      return {
        ...n,
        isLocal: n.id === local,
        workloads: [...(on.get(n.id) ?? new Map<string, number>())]
          .map(([service, count]): Workload => {
            const platform = PLATFORM.get(service);
            return platform
              ? { name: platform, kind: 'platform', count }
              : {
                  name: service.replace(/^pvx-/, ''),
                  kind: 'app',
                  count,
                  ...(pinned.has(service.replace(/^pvx-/, ''))
                    ? { pinned: true }
                    : {}),
                };
          })
          .sort((a, b) =>
            a.kind === b.kind
              ? a.name.localeCompare(b.name)
              : a.kind === 'platform'
                ? -1
                : 1,
          ),
      };
    });
    const managers = out.filter((n) => n.role !== 'worker').length;
    const warnings: string[] = [];
    if (managers === 2)
      warnings.push(
        'There are two managers. If either goes down the cluster stops accepting changes. Use one manager, or three.',
      );
    if (managers > 1 && managers % 2 === 0 && managers !== 2)
      warnings.push(
        `There are ${managers} managers. An odd number (1, 3 or 5) tolerates the same failures with one fewer machine.`,
      );
    // Traffic between machines only leaves a machine when there is more than one. The page words this one itself, with
    // the command beside it, so it is not also a line in the warnings.
    let encryptCommand: string | null = null;
    if (out.length > 1 && plain.length > 0) {
      const image =
        (await this.docker.serviceStatus('pvx-provelox'))?.image ??
        'ghcr.io/provelox/provelox:latest';
      encryptCommand = `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${image} encrypt-network`;
    }
    for (const u of unresolved) warnings.push(`${u.app}: ${u.reason}`);
    for (const n of out)
      if (n.state !== 'ready')
        warnings.push(
          `${n.hostname || n.id} is ${n.state}: its apps are not running there.`,
        );
    return {
      nodes: out,
      managers,
      warnings,
      canJoin: state === 'manager',
      encryptCommand,
    };
  }

  /** The tokens and commands for joining another machine. The tokens are secrets, so this is for the admin only. */
  async joinInstructions(): Promise<JoinInstructions> {
    const info = await this.docker.swarmJoinInfo();
    if (!info)
      throw new ConflictError(
        'This Docker host is not a Swarm manager, so other machines cannot join it from here.',
      );
    const image =
      (await this.docker.serviceStatus('pvx-provelox'))?.image ??
      'ghcr.io/provelox/provelox:latest';
    const role = (token: string): JoinRole => ({
      token,
      swarmCommand: `docker swarm join --token ${token} ${info.managerAddress}`,
      proveloxCommand: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${image} join --token ${token} --manager ${info.managerAddress}`,
    });
    return {
      managerAddress: info.managerAddress,
      image,
      worker: role(info.workerToken),
      manager: role(info.managerToken),
      ports: ['2377/tcp', '7946/tcp', '7946/udp', '4789/udp'],
    };
  }

  /** Makes the old token for a role stop working, for when it was shared more widely than it should have been. */
  async rotateToken(role: string): Promise<JoinInstructions> {
    if (role !== 'worker' && role !== 'manager')
      throw new ValidationError('role must be worker or manager.');
    await this.docker.rotateJoinToken(role);
    return this.joinInstructions();
  }

  private async find(id: string) {
    const nodes = await this.docker.listNodes(true);
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new NotFoundError('That machine is not in the cluster.');
    return { node, nodes };
  }

  /**
   * The machine this API talks to. The rules that protect it cannot be checked without knowing it, so not knowing is an
   * error, not a pass.
   */
  private async localId(): Promise<string> {
    const id = await this.docker.localNodeId();
    if (!id)
      throw new ConflictError(
        'Docker did not say which machine this API talks to, so the change was not made. Try again.',
      );
    return id;
  }

  /** Managers that are up and can take work: what the cluster and the platform's own services rely on. */
  private usableManagers(nodes: NodeInfo[], except?: string) {
    return nodes.filter(
      (n) =>
        n.id !== except &&
        n.role !== 'worker' &&
        n.state === 'ready' &&
        n.availability === 'active',
    );
  }

  /**
   * Stops a machine taking new work (pause), moves its work elsewhere and keeps it free (drain), or lets it take work
   * again (active). Pausing or draining the only manager that can take work would leave the platform's own services
   * nowhere to run.
   */
  async setAvailability(id: string, availability: string) {
    if (!['active', 'pause', 'drain'].includes(availability))
      throw new ValidationError('availability must be active, pause or drain.');
    const { node, nodes } = await this.find(id);
    if (
      availability !== 'active' &&
      node.role !== 'worker' &&
      this.usableManagers(nodes, id).length === 0
    )
      throw new ConflictError(
        'This is the only manager that can take work, and the platform’s own services run on a manager. Promote another machine first.',
      );
    await this.docker.updateNode(id, {
      availability: availability as Availability,
    });
  }

  /**
   * Makes a worker a manager, or a manager a worker. A cluster needs a manager at all times, and the machine this API
   * talks to must stay one: demoting it would cut the API off from the cluster it manages. Managers that are down do
   * not count: they cannot vote.
   */
  async setRole(id: string, role: string) {
    if (role !== 'worker' && role !== 'manager')
      throw new ValidationError('role must be worker or manager.');
    const { node, nodes } = await this.find(id);
    const current = node.role === 'worker' ? 'worker' : 'manager';
    if (current === role) return;
    if (role === 'manager') {
      if (node.state !== 'ready')
        throw new ConflictError(
          'That machine is not reachable, so it cannot become a manager.',
        );
    } else {
      if (id === (await this.localId()))
        throw new ConflictError(
          'This is the machine the API talks to. Demote it from another manager, or promote another machine and run the API there first.',
        );
      if (this.usableManagers(nodes, id).length === 0)
        throw new ConflictError(
          'This is the only manager that is up. A cluster needs one at all times: promote another machine first.',
        );
    }
    await this.docker.updateNode(id, { role: role as NodeRole });
  }

  /**
   * Takes a machine out of the cluster. A manager must be demoted first, the machine this API talks to cannot be
   * removed, and a machine that is still part of the cluster has to leave it itself (`docker swarm leave`), after which
   * it shows as down and can be removed here. Apps held to the machine by their data must be released first, or the
   * data would be stranded with nothing saying so.
   */
  async remove(id: string) {
    const { node } = await this.find(id);
    if (id === (await this.localId()))
      throw new ConflictError(
        'This is the machine the API talks to, so it cannot be removed from here.',
      );
    if (node.role !== 'worker')
      throw new ConflictError(
        'This machine is a manager. Demote it to a worker before removing it.',
      );
    if (node.state === 'ready')
      throw new ConflictError(
        'This machine is still part of the cluster. Drain it, run `docker swarm leave` on it, and when it shows as down remove it here.',
      );
    const held = this.apps.pinnedApps(id);
    if (held.length > 0)
      throw new ConflictError(
        `${held.join(', ')} keep${held.length === 1 ? 's' : ''} data on this machine. Removing it would leave that data behind. Release each one first (Configuration → Where it runs) once you have moved or given up its data.`,
      );
    // Docker only removes a machine that is down, so this is the forced path for one that has left or is lost
    await this.docker.removeNode(id, true);
  }
}
