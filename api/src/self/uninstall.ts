import type { DockerPort, ManagedObjects } from '../docker/docker.port';
import { LABEL_APP } from '../common/naming';
import { CONSOLE_SERVICE } from './console-spec';
import { SELF_ADMIN_SECRET, SELF_JWT_SECRET, SELF_SERVICE } from './api-spec';
import { CONSOLE_SESSION_SECRET } from './console-spec';

/** Provelox's own services. Everything else it made is an app. */
const TRAEFIK_SERVICE = 'pvx-traefik';
const PLATFORM = [CONSOLE_SERVICE, SELF_SERVICE, TRAEFIK_SERVICE];
/** Secrets of the platform itself: made again by `install`. Every other secret is an app's, and its value is kept nowhere else. */
const PLATFORM_SECRETS = [
  SELF_JWT_SECRET,
  SELF_ADMIN_SECRET,
  CONSOLE_SESSION_SECRET,
];

const MIDDLEWARE = /^traefik\.http\.middlewares\.([^.]+)\.errors\.service$/;
const ROUTER_CHAIN = /^traefik\.http\.routers\.[^.]+\.middlewares$/;

export interface LabelChange {
  label: string;
  /** The new value, or null when the label goes */
  to: string | null;
}

export interface DetachPlan {
  /** Apps whose routes lose the error-page step, with the label changes that do it */
  apps: { service: string; app: string; changes: LabelChange[] }[];
  /** Apps behind "Sign in with…": left as they are, and they refuse visitors once the API is gone */
  signIn: string[];
}

const isApp = (name: string) => !PLATFORM.includes(name);

/**
 * A tag that can name a different image tomorrow: none at all, or one with no digit in it (latest, stable, main, live).
 * Apps come back from a reinstall by pulling their tag again, so such an app may come back as a newer build.
 */
export function isMovingTag(image: string): boolean {
  if (!image) return false;
  const last = image.split('/').pop() ?? image;
  const colon = last.indexOf(':');
  if (colon === -1) return true;
  return !/\d/.test(last.slice(colon + 1));
}

/**
 * What it takes for an app's routes not to depend on the API. Each app's routes run an "errors" step that fetches
 * pages from a service the API defines in its own labels: when the API goes, the proxy drops every route that uses
 * it. The step and its definition are taken out; nothing else about the routes changes.
 */
export function planDetach(objects: ManagedObjects): DetachPlan {
  const plan: DetachPlan = { apps: [], signIn: [] };
  for (const s of objects.services) {
    if (!isApp(s.name)) continue;
    const dead = new Set<string>();
    for (const [k, v] of Object.entries(s.labels)) {
      const m = MIDDLEWARE.exec(k);
      // An errors step that sends to a service of ours, found by its address (name@swarm) not being the app's own
      if (m && v.endsWith('@swarm')) dead.add(m[1]);
    }
    if (Object.keys(s.labels).some((k) => /\.forwardauth\.address$/.test(k)))
      plan.signIn.push(s.name);
    if (dead.size === 0) continue;
    const changes: LabelChange[] = [];
    for (const [k, v] of Object.entries(s.labels)) {
      if ([...dead].some((m) => k.startsWith(`traefik.http.middlewares.${m}.`)))
        changes.push({ label: k, to: null });
      else if (ROUTER_CHAIN.test(k)) {
        const list = v.split(',').filter(Boolean);
        const kept = list.filter((m) => !dead.has(m));
        if (kept.length !== list.length)
          changes.push({ label: k, to: kept.length ? kept.join(',') : null });
      }
    }
    plan.apps.push({
      service: s.name,
      app: s.labels[LABEL_APP] ?? s.name,
      changes,
    });
  }
  return plan;
}

/** Applies the plan. Only labels change, so nothing restarts. Returns the apps that were changed. */
export async function detach(
  docker: DockerPort,
  plan: DetachPlan,
): Promise<string[]> {
  const done: string[] = [];
  for (const a of plan.apps) {
    const ok = await docker.editService(a.service, a.app, (spec) => {
      const labels = { ...spec.Labels };
      for (const c of a.changes)
        if (c.to === null) delete labels[c.label];
        else labels[c.label] = c.to;
      return { ...spec, Labels: labels };
    });
    if (ok) done.push(a.service);
  }
  return done;
}

export interface UninstallOptions {
  /** Also stop and remove the apps and the proxy. Without it the apps are left running: only the console and API go */
  removeApps: boolean;
  /** Also delete volumes: databases, uploads, certificates */
  deleteData: boolean;
}

export interface UninstallPlan {
  detach: DetachPlan | null;
  /** In the order they are removed */
  remove: {
    kind: 'service' | 'network' | 'secret' | 'config' | 'volume';
    name: string;
  }[];
  /** Volumes that stay, so the person knows what is left */
  keptVolumes: string[];
  /** Apps' secrets that stay: Provelox cannot read a secret back, so they cannot be made again */
  keptSecrets: string[];
  /** Apps that stop (and run again only after a reinstall). Empty when the apps are left running. */
  stops: { service: string; image: string; moving: boolean }[];
}

export function planUninstall(
  objects: ManagedObjects,
  o: UninstallOptions,
): UninstallPlan {
  const names = objects.services.map((s) => s.name);
  const remove: UninstallPlan['remove'] = [];
  if (!o.removeApps) {
    for (const n of [CONSOLE_SERVICE, SELF_SERVICE])
      if (names.includes(n)) remove.push({ kind: 'service', name: n });
    return {
      detach: planDetach(objects),
      remove,
      keptVolumes: objects.volumes.map((v) => v.name),
      keptSecrets: [],
      stops: [],
    };
  }
  // Apps first, then the platform with the proxy last, so the addresses answer for as long as possible
  for (const n of names.filter(isApp))
    remove.push({ kind: 'service', name: n });
  for (const n of [CONSOLE_SERVICE, SELF_SERVICE, TRAEFIK_SERVICE])
    if (names.includes(n)) remove.push({ kind: 'service', name: n });
  // An app's secret exists only in Docker: remove it and the app cannot be brought back with its values
  const appSecrets = objects.secrets.filter(
    (n) => !PLATFORM_SECRETS.includes(n),
  );
  for (const n of objects.secrets)
    if (o.deleteData || PLATFORM_SECRETS.includes(n))
      remove.push({ kind: 'secret', name: n });
  for (const n of objects.configs) remove.push({ kind: 'config', name: n });
  for (const n of objects.networks)
    remove.push({ kind: 'network', name: n.name });
  if (o.deleteData)
    for (const v of objects.volumes)
      remove.push({ kind: 'volume', name: v.name });
  return {
    detach: null,
    remove,
    keptVolumes: o.deleteData ? [] : objects.volumes.map((v) => v.name),
    keptSecrets: o.deleteData ? [] : appSecrets,
    stops: objects.services
      .filter((s) => isApp(s.name))
      .map((s) => ({
        service: s.name,
        image: s.image,
        moving: isMovingTag(s.image),
      })),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Carries the plan out. A volume or network Docker still holds (the containers stop a moment after their service is
 * removed) is retried for a while before it is reported as left behind. Never leaves the Swarm.
 */
export async function uninstall(
  docker: DockerPort,
  plan: UninstallPlan,
  wait = sleep,
): Promise<{ removed: string[]; left: string[] }> {
  const removed: string[] = [];
  const left: string[] = [];
  if (plan.detach) await detach(docker, plan.detach);
  for (const r of plan.remove) {
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      try {
        await docker.removeManaged(r.kind, r.name);
        ok = true;
      } catch (e) {
        if (r.kind === 'service' || i === 9) {
          left.push(
            `${r.kind} ${r.name}: ${e instanceof Error ? e.message : e}`,
          );
          break;
        }
        await wait(2000);
      }
    }
    if (ok) removed.push(`${r.kind} ${r.name}`);
  }
  return { removed, left };
}
