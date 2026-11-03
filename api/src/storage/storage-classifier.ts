/**
 * Decides what each Docker volume and image on this host IS, using only what Provelox can prove.
 *
 * The host may run other things too. A volume or image is only offered for deletion without question when we can
 * show that we created it. Everything else needs an explicit acknowledgement, and anything in use, declared by an
 * app or needed by the platform can never be deleted.
 *
 * Pure functions: callers fetch the facts from Docker and the app store, and re-run this right before deleting.
 */

export interface ContainerFact {
  id: string;
  name: string;
  imageId: string;
  imageName: string;
  /** Swarm service the container belongs to, when it has one */
  service?: string;
  mounts: { type: string; name?: string }[];
}

export interface AppFact {
  appName: string;
  /** Set for apps of a Compose project: their volumes are owned by the project */
  project?: string;
  deployedVersion: number;
  versions: { version: number; image: string }[];
  /** Docker names of the volumes the app declares (already prefixed) */
  volumeNames: string[];
}

export interface VolumeFact {
  name: string;
  labels: Record<string, string>;
  mountpoint?: string;
  createdAt?: string;
  sizeBytes?: number;
}

export interface ImageFact {
  id: string;
  tags: string[];
  sizeBytes: number;
  /** seconds since the epoch */
  createdAt: number;
}

/** What a client has to do before something can be deleted */
export type DeleteRule =
  | 'yes' // we can show that we created it
  | 'acknowledge' // owner unknown: needs an explicit "I know what this is"
  | 'no'; // in use, declared, or needed by the platform

export type VolumeKind =
  | 'in-use'
  | 'declared'
  | 'provelox-orphan'
  | 'migration-original'
  | 'unnamed-orphan'
  | 'named-orphan';

export interface VolumeReportItem {
  name: string;
  kind: VolumeKind;
  delete: DeleteRule;
  reason: string;
  sizeBytes?: number;
  createdAt?: string;
  mountpoint?: string;
  usedBy: { container: string; service?: string }[];
  /** The app that declares it, or that it was created for */
  app?: string;
  project?: string;
  /** Migration lineage: the volume this one's data was copied to */
  copiedTo?: string;
}

export type ImageKind =
  'in-use' | 'system' | 'kept-version' | 'old-version' | 'other-unused';

export interface ImageReportItem {
  id: string;
  tags: string[];
  sizeBytes: number;
  createdAt: number;
  kind: ImageKind;
  delete: DeleteRule;
  reason: string;
  app?: string;
  version?: number;
}

const ANONYMOUS_NAME = /^[0-9a-f]{64}$/;
export const LABEL_MANAGED = 'io.provelox.managed';
export const LABEL_APP = 'io.provelox.app';
export const LABEL_PROJECT = 'io.provelox.project';
export const LABEL_MIGRATED_FROM = 'io.provelox.migrated-from';

/** "ghcr.io/org/app:1" → "ghcr.io/org/app". A registry port ("host:5000/app") is not a tag. */
export function imageRepository(tag: string) {
  const noDigest = tag.split('@')[0];
  const lastSlash = noDigest.lastIndexOf('/');
  const lastColon = noDigest.lastIndexOf(':');
  return lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
}

export function classifyVolumes(
  volumes: VolumeFact[],
  containers: ContainerFact[],
  apps: AppFact[],
): VolumeReportItem[] {
  const usedBy = new Map<string, { container: string; service?: string }[]>();
  for (const c of containers)
    for (const m of c.mounts) {
      if (m.type !== 'volume' || !m.name) continue;
      usedBy.set(m.name, [
        ...(usedBy.get(m.name) ?? []),
        { container: c.name, service: c.service },
      ]);
    }

  const declared = new Map<string, AppFact>();
  for (const a of apps) for (const v of a.volumeNames) declared.set(v, a);

  // A volume a migration created points back at the original it copied. That proves the original was ours to begin
  // with (it was the unnamed volume of one of our apps), even though it carries no label of its own.
  const copiedTo = new Map<string, { to: string; app?: string }>();
  for (const v of volumes) {
    const from = v.labels?.[LABEL_MIGRATED_FROM];
    if (from && v.labels?.[LABEL_MANAGED] === 'true')
      copiedTo.set(from, { to: v.name, app: v.labels[LABEL_APP] });
  }

  return volumes.map((v): VolumeReportItem => {
    const base = {
      name: v.name,
      sizeBytes: v.sizeBytes,
      createdAt: v.createdAt,
      mountpoint: v.mountpoint,
      usedBy: usedBy.get(v.name) ?? [],
    };
    if (base.usedBy.length > 0)
      return {
        ...base,
        kind: 'in-use',
        delete: 'no',
        reason: 'A container is using it.',
      };

    const owner = declared.get(v.name);
    if (owner)
      return {
        ...base,
        kind: 'declared',
        delete: 'no',
        app: owner.appName,
        project: owner.project,
        reason: `${owner.appName} mounts it. The app is stopped or has not started yet.`,
      };

    const lineage = copiedTo.get(v.name);
    if (lineage)
      return {
        ...base,
        kind: 'migration-original',
        delete: 'yes',
        app: lineage.app,
        copiedTo: lineage.to,
        reason: `The original data of ${lineage.app ?? 'an app'}, left in place after it was copied to ${lineage.to}.`,
      };

    if (v.labels?.[LABEL_MANAGED] === 'true')
      return {
        ...base,
        kind: 'provelox-orphan',
        delete: 'yes',
        app: v.labels[LABEL_APP],
        project: v.labels[LABEL_PROJECT],
        reason: 'Created by Provelox and not used by anything any more.',
      };

    if (ANONYMOUS_NAME.test(v.name))
      return {
        ...base,
        kind: 'unnamed-orphan',
        delete: 'acknowledge',
        reason:
          'An unnamed volume that no container uses. Some container that no longer exists created it, and we cannot tell whose.',
      };

    return {
      ...base,
      kind: 'named-orphan',
      delete: 'acknowledge',
      reason:
        'No container uses it and no app mounts it. It may be left over from something deleted, or belong to another tool.',
    };
  });
}

export function classifyImages(
  images: ImageFact[],
  containers: ContainerFact[],
  apps: AppFact[],
  keepVersions: number,
  systemImageNames: string[],
): ImageReportItem[] {
  const systemRepos = new Set(systemImageNames.map(imageRepository));
  const inUseIds = new Set(containers.map((c) => c.imageId));
  const inUseTags = new Set(containers.map((c) => c.imageName));

  // tag → every (app, version) that deployed it
  const deployments = new Map<
    string,
    { app: string; version: number; kept: boolean }[]
  >();
  for (const app of apps)
    for (const v of app.versions) {
      if (!v.image) continue;
      deployments.set(v.image, [
        ...(deployments.get(v.image) ?? []),
        // The deployed version and the `keepVersions` before it are kept
        {
          app: app.appName,
          version: v.version,
          kept: v.version >= app.deployedVersion - keepVersions,
        },
      ]);
    }

  return images.map((img): ImageReportItem => {
    const base = {
      id: img.id,
      tags: img.tags,
      sizeBytes: img.sizeBytes,
      createdAt: img.createdAt,
    };

    if (inUseIds.has(img.id) || img.tags.some((t) => inUseTags.has(t)))
      return {
        ...base,
        kind: 'in-use',
        delete: 'no',
        reason: 'A container is running or stopped on it.',
      };

    if (img.tags.some((t) => systemRepos.has(imageRepository(t))))
      return {
        ...base,
        kind: 'system',
        delete: 'no',
        reason: 'Provelox needs this image to run.',
      };

    const related = img.tags.flatMap((t) => deployments.get(t) ?? []);
    if (related.length > 0) {
      const keptOne = related.find((d) => d.kept);
      if (keptOne)
        return {
          ...base,
          kind: 'kept-version',
          delete: 'no',
          app: keptOne.app,
          version: keptOne.version,
          reason: `A recent version of ${keptOne.app}, kept so you can roll back.`,
        };
      const newest = related.reduce((a, b) => (b.version > a.version ? b : a));
      return {
        ...base,
        kind: 'old-version',
        delete: 'yes',
        app: newest.app,
        version: newest.version,
        reason: `Version ${newest.version} of ${newest.app}, older than the ${keepVersions + 1} most recent.`,
      };
    }

    return {
      ...base,
      kind: 'other-unused',
      delete: 'acknowledge',
      reason: img.tags.length
        ? 'No app deploys it and no container uses it. It may belong to something other than Provelox.'
        : 'An untagged image layer no container uses.',
    };
  });
}

export function summarizeReclaimable(
  items: { sizeBytes?: number; delete: DeleteRule }[],
) {
  let provable = 0;
  let needsAck = 0;
  for (const i of items) {
    if (i.delete === 'yes') provable += i.sizeBytes ?? 0;
    if (i.delete === 'acknowledge') needsAck += i.sizeBytes ?? 0;
  }
  return { provable, needsAck };
}
