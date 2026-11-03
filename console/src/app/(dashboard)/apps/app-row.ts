import type { ImageUpdate } from '@/lib/image-updates';
import { siteUrl, type ProxyPorts } from '@/lib/site-url';
import { appDomains, type AppDefinition } from '@/lib/types';

/** What the apps list needs about one app, small enough to hand to the browser. */
export interface AppRow {
  name: string;
  domains: { host: string; ssl: boolean; url: string }[];
  exposed: boolean;
  customDomainsOnly: boolean;
  persistent: boolean;
  /** The compose project (template or stack) this app belongs to, if any */
  project?: string;
  instanceCount: number;
  /** What it runs, as deployed (registry/name:tag); empty before its first deploy */
  image?: string;
  building: boolean;
  runState?: 'running' | 'starting' | 'failed' | 'stopped';
  /** What the app's health check says, when it has one */
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  version: number;
  lastDeployed?: string;
  /** What the registry says about the app's image, when it has been checked */
  update?: ImageUpdate;
}

export type AppStatus =
  'running' | 'starting' | 'failed' | 'unhealthy' | 'stopped' | 'building';

export const statusOf = (
  r: Pick<AppRow, 'building' | 'instanceCount' | 'runState' | 'health'>,
): AppStatus => {
  if (r.building) return 'building';
  if (r.instanceCount === 0) return 'stopped';
  // Only what Docker reports can say "running": having an instance count does not
  if (r.runState === 'failed' || r.runState === 'starting') return r.runState;
  // Running, but its own health check says otherwise: a running app that is not well
  if (r.health === 'unhealthy') return 'unhealthy';
  if (r.health === 'starting') return 'starting';
  return 'running';
};

export function toRow(
  app: AppDefinition,
  rootDomain: string,
  ports?: ProxyPorts,
): AppRow {
  const latest =
    app.versions.find((v) => v.version === app.deployedVersion) ??
    app.versions[app.versions.length - 1];
  return {
    name: app.appName,
    domains: appDomains(app, rootDomain).map(({ host, ssl }) => ({
      host,
      ssl,
      url: siteUrl({ host, ssl }, ports),
    })),
    exposed: !app.notExposeAsWebApp,
    customDomainsOnly: !!app.disableDefaultSubDomain,
    persistent: app.hasPersistentData,
    project: app.project,
    instanceCount: app.instanceCount,
    image: app.image ?? '',
    building: !!app.isAppBuilding,
    runState: app.runState,
    health: app.runStatus?.health,
    version: app.deployedVersion,
    lastDeployed: app.deployedVersion > 0 ? latest?.timeStamp : undefined,
  };
}

/**
 * Whether two rows show the same thing. A refresh hands over new objects with the same content; the list draws a row
 * again only when this says it changed. Every field counts, those on only one of the two included.
 */
export function sameRow(a: AppRow, b: AppRow): boolean {
  if (a === b) return true;
  const { domains: ad, update: au, ...ar } = a;
  const { domains: bd, update: bu, ...br } = b;
  const keys = new Set([...Object.keys(ar), ...Object.keys(br)]) as Set<
    keyof typeof ar
  >;
  for (const k of keys) if (ar[k] !== br[k]) return false;
  return (
    JSON.stringify(ad) === JSON.stringify(bd) &&
    JSON.stringify(au) === JSON.stringify(bu)
  );
}

export type SortKey = 'name' | 'status' | 'cpu' | 'memory' | 'deployed';

export const SORT_LABEL: Record<SortKey, string> = {
  name: 'Name',
  status: 'Status (problems first)',
  cpu: 'CPU use',
  memory: 'Memory use',
  deployed: 'Recently deployed',
};

/** Problems first, so what needs attention is at the top. */
const STATUS_ORDER: Record<AppStatus, number> = {
  failed: 0,
  unhealthy: 1,
  starting: 2,
  building: 3,
  running: 4,
  stopped: 5,
};

export type UsageReading = { cpuPercent: number; memoryBytes: number };

/**
 * The rows in the order asked for, without changing the list given. Ties and apps with no reading keep name order, so
 * the list does not shuffle between refreshes.
 */
export function sortRows(
  rows: AppRow[],
  key: SortKey,
  usage: Record<string, UsageReading> = {},
): AppRow[] {
  const byName = (a: AppRow, b: AppRow) => a.name.localeCompare(b.name);
  const by: Record<SortKey, (a: AppRow, b: AppRow) => number> = {
    name: byName,
    status: (a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)],
    // heaviest first; an app with no reading (stopped, or not read yet) counts as using nothing
    cpu: (a, b) =>
      (usage[b.name]?.cpuPercent ?? 0) - (usage[a.name]?.cpuPercent ?? 0),
    memory: (a, b) =>
      (usage[b.name]?.memoryBytes ?? 0) - (usage[a.name]?.memoryBytes ?? 0),
    deployed: (a, b) =>
      (b.lastDeployed ? Date.parse(b.lastDeployed) : 0) -
      (a.lastDeployed ? Date.parse(a.lastDeployed) : 0),
  };
  return [...rows].sort((a, b) => by[key](a, b) || byName(a, b));
}

/** The image without its registry host, for a line of text: "registry.example.com/lumen/api:2.31.4" → "lumen/api:2.31.4". */
export function shortImage(image: string): string {
  const first = image.split('/')[0];
  const hasHost =
    image.includes('/') && (first.includes('.') || first.includes(':'));
  return (hasHost ? image.slice(first.length + 1) : image).replace(
    /@sha256:[a-f0-9]+$/,
    '',
  );
}
