import type { AppDefinition } from '../apps/app.model';
import { needsGap } from './adopt';

/** What an update would do to one service, in words a person can check before pressing Deploy. */
export interface ServiceDiff {
  app: string;
  service: string;
  /**
   * create: new. unchanged: nothing differs, so nothing restarts. update: changes that apply without a restart (an
   * address, the number of instances). restart: the container is replaced. remove: no longer in the file.
   */
  action: 'create' | 'unchanged' | 'update' | 'restart' | 'remove';
  /** What differs. Never the value of an environment variable: only its name. */
  reasons: string[];
  /**
   * For a restart: whether the service is briefly unavailable. A service with data on a volume stops before the new
   * one starts; every other service starts the new container before the old one stops.
   */
  briefOutage: boolean;
  /** Environment variables whose name looks like a secret and whose value differs from what is running */
  secretsChanged: string[];
}

const SECRET_LIKE = /PASS|SECRET|TOKEN|KEY|CREDENTIAL/i;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const names = (keys: string[]) => keys.join(', ');

/** Environment changes by name: what was added, removed, or given another value. */
function envChanges(from: AppDefinition['env'], to: AppDefinition['env']) {
  const before = new Map(from.map((e) => [e.key, e.value]));
  const after = new Map(to.map((e) => [e.key, e.value]));
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...after.keys()].filter(
      (k) => before.has(k) && before.get(k) !== after.get(k),
    ),
  };
}

/** Fields whose change replaces the container, with how to say it. Compared as a whole, so no value is ever quoted. */
const RESTART_FIELDS: [keyof AppDefinition, string][] = [
  ['command', 'its command'],
  ['entrypoint', 'its entrypoint'],
  ['ports', 'its published ports'],
  ['volumes', 'its volumes'],
  ['healthcheck', 'its health check'],
  ['resources', 'its memory or CPU limits'],
  ['workingDir', 'its working directory'],
  ['user', 'the user it runs as'],
  ['restart', 'its restart policy'],
];

/** Compares the service as it is with the definition the update would give it. `existing` is undefined for a new service. */
export function diffService(
  existing: AppDefinition | undefined,
  planned: AppDefinition,
): ServiceDiff {
  const base = {
    app: planned.name,
    service: planned.serviceAlias ?? planned.name,
    briefOutage: false,
    secretsChanged: [] as string[],
  };
  if (!existing) return { ...base, action: 'create', reasons: ['new service'] };

  const restart: string[] = [];
  const update: string[] = [];
  const secretsChanged: string[] = [];

  if (existing.image !== planned.image)
    restart.push(`image ${existing.image || '(none)'} → ${planned.image}`);

  const env = envChanges(existing.env, planned.env);
  const parts = [
    env.changed.length ? `${names(env.changed)} changed` : '',
    env.added.length ? `${names(env.added)} added` : '',
    env.removed.length ? `${names(env.removed)} removed` : '',
  ].filter(Boolean);
  if (parts.length) restart.push(`environment: ${parts.join(', ')}`);
  for (const k of env.changed) if (SECRET_LIKE.test(k)) secretsChanged.push(k);

  for (const [field, label] of RESTART_FIELDS)
    if (!same(existing[field] ?? null, planned[field] ?? null))
      restart.push(`${label} changed`);

  if (existing.instanceCount !== planned.instanceCount)
    update.push(
      `instances ${existing.instanceCount} → ${planned.instanceCount}`,
    );
  if (
    existing.exposed !== planned.exposed ||
    existing.containerPort !== planned.containerPort
  )
    update.push('how it is reached from the internet changed');

  if (restart.length)
    return {
      ...base,
      action: 'restart',
      reasons: [...restart, ...update],
      // Services with data on a volume stop first: see apps/service-spec.ts (Order)
      briefOutage: planned.persistent,
      secretsChanged,
    };
  if (update.length)
    return { ...base, action: 'update', reasons: update, secretsChanged };
  return { ...base, action: 'unchanged', reasons: [], secretsChanged };
}

/**
 * One entry per service in the file, then one for each service of the project that the file no longer has. `renamed`
 * is the app each renamed service comes from, by the new app's name: such a service is the old one carried on (it keeps
 * its addresses and history), not a new one, and the old one is not listed as removed.
 */
export function diffPlan(
  existing: AppDefinition[],
  planned: AppDefinition[],
  willRemove: boolean,
  renamed: Map<string, AppDefinition> = new Map(),
): ServiceDiff[] {
  const out = planned.map((p) => {
    const from = renamed.get(p.name);
    if (!from)
      return diffService(
        existing.find((e) => e.name === p.name),
        p,
      );
    const d = diffService(from, p);
    // Always a new Swarm service under a new name, so always a restart; a service with data stops the old one first
    return {
      ...d,
      action: 'restart' as const,
      reasons: [
        `renamed from ${from.serviceAlias ?? from.name}: it keeps its addresses, deploy keys and history`,
        ...d.reasons,
      ],
      briefOutage: needsGap(from),
    };
  });
  const gone = new Set([...renamed.values()].map((a) => a.name));
  if (willRemove)
    for (const e of existing)
      if (!planned.some((p) => p.name === e.name) && !gone.has(e.name))
        out.push({
          app: e.name,
          service: e.serviceAlias ?? e.name,
          action: 'remove',
          reasons: ['no longer in the file; its volumes are kept'],
          briefOutage: false,
          secretsChanged: [],
        });
  return out;
}
