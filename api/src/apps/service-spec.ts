import {
  LABEL_APP,
  LABEL_MANAGED,
  LABEL_PROJECT,
  projectNetwork,
  serviceName,
  SHARED_NETWORK,
  volumeName,
} from '../common/naming';
import { routingLabels, type RoutingContext } from '../proxy/traefik-labels';
import type { AppDefinition } from './app.model';

export interface SpecContext extends RoutingContext {
  /** Runs until the first real deploy */
  placeholderImage: string;
  /** The Swarm config holding the placeholder page, mounted while the placeholder image runs */
  placeholder: { id: string; name: string } | null;
  /** The placeholder image's server settings, which send the page with a no-script policy */
  placeholderConf?: { id: string; name: string } | null;
  /** The id of the machine an app with local volumes is held to, once the cluster has more than one */
  pinnedNode?: string | null;
}

/** Where the placeholder image serves its page from */
export const PLACEHOLDER_FILE = '/usr/share/nginx/html/index.html';
/** Where the placeholder image reads its server settings from */
export const PLACEHOLDER_CONF_FILE = '/etc/nginx/conf.d/default.conf';

/** The subset of Docker's Swarm ServiceSpec this service sets. */
export interface SwarmServiceSpec {
  Name: string;
  Labels: Record<string, string>;
  TaskTemplate: Record<string, any>;
  Mode: { Replicated: { Replicas: number } };
  UpdateConfig: Record<string, any>;
  RollbackConfig: Record<string, any>;
  EndpointSpec?: { Ports: Record<string, any>[] };
}

const NS = 1_000_000_000;

/** Which owner a named volume belongs to: the project when there is one (volumes are shared inside it). */
export const volumeOwner = (app: AppDefinition) => app.project ?? app.name;

/** The Docker volume behind a named mount: the name it was created under, else the one derived from its owner. */
export const mountSource = (
  app: AppDefinition,
  v: { volumeName?: string; dockerName?: string },
) => v.dockerName ?? volumeName(volumeOwner(app), v.volumeName as string);

/**
 * The Swarm service an app definition describes. Pure: no Docker calls, so the whole mapping is unit-testable.
 * Re-applying the same definition always yields the same spec.
 */
export function buildServiceSpec(
  app: AppDefinition,
  ctx: SpecContext,
): SwarmServiceSpec {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: 'true',
    [LABEL_APP]: app.name,
    'io.provelox.deploy-version': String(app.deployVersion),
    ...routingLabels(app, ctx),
  };
  if (app.project) labels[LABEL_PROJECT] = app.project;

  const networks: { Target: string; Aliases: string[] }[] = [
    { Target: SHARED_NETWORK, Aliases: [app.name, ...app.aliases] },
  ];
  if (app.project)
    networks.push({
      Target: projectNetwork(app.project),
      Aliases: [app.serviceAlias ?? app.name],
    });

  const mounts = app.volumes.map((v) =>
    v.volumeName
      ? {
          Type: 'volume',
          Source: mountSource(app, v),
          Target: v.containerPath,
          ReadOnly: v.readOnly,
          VolumeOptions: {
            Labels: {
              [LABEL_MANAGED]: 'true',
              ...(app.project
                ? { [LABEL_PROJECT]: app.project }
                : { [LABEL_APP]: app.name }),
            },
          },
        }
      : {
          Type: 'bind',
          Source: v.hostPath as string,
          Target: v.containerPath,
          ReadOnly: v.readOnly,
        },
  );

  const container: Record<string, any> = {
    Image: app.image || ctx.placeholderImage,
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: app.name },
    Env: app.env.map((e) => `${e.key}=${e.value}`),
    Mounts: mounts,
  };
  if (!app.image && ctx.placeholder)
    container.Configs = [
      {
        ConfigID: ctx.placeholder.id,
        ConfigName: ctx.placeholder.name,
        File: { Name: PLACEHOLDER_FILE, UID: '0', GID: '0', Mode: 0o444 },
      },
      ...(ctx.placeholderConf
        ? [
            {
              ConfigID: ctx.placeholderConf.id,
              ConfigName: ctx.placeholderConf.name,
              File: {
                Name: PLACEHOLDER_CONF_FILE,
                UID: '0',
                GID: '0',
                Mode: 0o444,
              },
            },
          ]
        : []),
    ];
  if (app.secrets.length > 0)
    container.Secrets = app.secrets.map((s) => ({
      SecretID: s.id,
      SecretName: s.dockerName,
      File: { Name: s.name, UID: '0', GID: '0', Mode: 0o444 },
    }));
  if (app.command) container.Args = app.command;
  if (app.entrypoint) container.Command = app.entrypoint;
  if (app.workingDir) container.Dir = app.workingDir;
  if (app.user) container.User = app.user;
  if (app.healthcheck) {
    const h = app.healthcheck;
    container.Healthcheck = {
      Test: h.test,
      ...(h.intervalSeconds && { Interval: h.intervalSeconds * NS }),
      ...(h.timeoutSeconds && { Timeout: h.timeoutSeconds * NS }),
      ...(h.retries && { Retries: h.retries }),
      ...(h.startPeriodSeconds !== undefined && {
        StartPeriod: h.startPeriodSeconds * NS,
      }),
    };
  }

  const task: Record<string, any> = {
    ContainerSpec: container,
    Networks: networks,
    RestartPolicy: {
      Condition:
        app.restart === 'any'
          ? 'any'
          : app.restart === 'on-failure'
            ? 'on-failure'
            : 'none',
    },
  };
  if (app.resources) {
    task.Resources = {
      Limits: {
        ...(app.resources.cpus && {
          NanoCPUs: Math.round(app.resources.cpus * NS),
        }),
        ...(app.resources.memoryBytes && {
          MemoryBytes: app.resources.memoryBytes,
        }),
      },
    };
  }

  // Where in a cluster it may run: held to the machine with its volume, else the machine or role chosen, else anywhere
  const constraints = ctx.pinnedNode
    ? [`node.id==${ctx.pinnedNode}`]
    : app.placement?.node
      ? [`node.hostname==${app.placement.node}`]
      : app.placement?.role
        ? [`node.role==${app.placement.role}`]
        : [];
  if (constraints.length > 0) task.Placement = { Constraints: constraints };

  // Apps that keep data run one instance, and the old task stops before the new one starts so two
  // containers never write to the same volume.
  const replicas = app.persistent
    ? Math.min(app.instanceCount, 1)
    : app.instanceCount;
  const order = app.persistent ? 'stop-first' : 'start-first';

  const spec: SwarmServiceSpec = {
    Name: serviceName(app.name),
    Labels: labels,
    TaskTemplate: task,
    Mode: { Replicated: { Replicas: replicas } },
    UpdateConfig: { Parallelism: 1, Order: order, FailureAction: 'rollback' },
    RollbackConfig: { Parallelism: 1, Order: order },
  };
  if (app.ports.length > 0)
    spec.EndpointSpec = {
      Ports: app.ports.map((p) => ({
        Protocol: p.protocol,
        TargetPort: p.containerPort,
        PublishedPort: p.hostPort,
        PublishMode: 'ingress',
      })),
    };
  return spec;
}
