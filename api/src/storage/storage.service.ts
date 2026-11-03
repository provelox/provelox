import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppsRepo } from '../apps/apps.repo';
import { mountSource } from '../apps/service-spec';
import { NotFoundError, ValidationError } from '../common/errors';
import { CONFIG, type Config } from '../config/config';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import {
  classifyImages,
  classifyVolumes,
  summarizeReclaimable,
  type AppFact,
  type ImageReportItem,
  type VolumeReportItem,
} from './storage-classifier';

export interface StorageReport {
  totals: { imagesBytes: number; containers: number; volumesBytes: number };
  keepVersions: number;
  volumes: VolumeReportItem[];
  images: ImageReportItem[];
  reclaimable: {
    volumes: { provable: number; needsAck: number };
    images: { provable: number; needsAck: number };
  };
}

export interface DeleteResult {
  deleted: string[];
  skipped: { id: string; reason: string }[];
}

/** What a monitor needs about the disk: the sizes, and what could be cleared, without names that matter. */
export interface StorageSummary {
  imagesBytes: number;
  volumesBytes: number;
  containers: number;
  /** What can be deleted with certainty (unused, and Provelox's own to delete) */
  reclaimableImagesBytes: number;
  reclaimableVolumesBytes: number;
  topVolumes: {
    name: string;
    sizeBytes: number;
    app?: string;
    inUse: boolean;
  }[];
  topImages: {
    name: string;
    sizeBytes: number;
    kind: string;
    app?: string;
    deletable: boolean;
  }[];
}

/** Sizing volumes makes Docker walk every one of them, so a reading is kept for a little while. */
const SUMMARY_FRESH_MS = 30_000;
const TOP = 8;

const keep = z.number().int().min(0).max(50);

@Injectable()
export class StorageService {
  constructor(
    private readonly apps: AppsRepo,
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  private appFacts(): AppFact[] {
    return this.apps.list().map((a) => ({
      appName: a.name,
      project: a.project,
      deployedVersion: a.deployVersion,
      versions: a.versions.map((v) => ({ version: v.version, image: v.image })),
      volumeNames: a.volumes
        .filter((v) => v.volumeName)
        .map((v) => mountSource(a, v)),
    }));
  }

  /** Images the platform itself runs; they are never offered for deletion. */
  private systemImages() {
    return [this.cfg.TRAEFIK_IMAGE, this.cfg.PLACEHOLDER_IMAGE];
  }

  private async classify(keepVersions: number) {
    const facts = await this.docker.storageFacts();
    const apps = this.appFacts();
    return {
      facts,
      volumes: classifyVolumes(facts.volumes, facts.containers, apps),
      images: classifyImages(
        facts.images,
        facts.containers,
        apps,
        keepVersions,
        this.systemImages(),
      ),
    };
  }

  private parseKeep(keepVersions: unknown) {
    const parsed = keep.safeParse(keepVersions);
    if (!parsed.success)
      throw new ValidationError(
        'keepVersions must be a whole number from 0 to 50.',
      );
    return parsed.data;
  }

  async report(keepVersions = 1): Promise<StorageReport> {
    const k = this.parseKeep(keepVersions);
    const { facts, volumes, images } = await this.classify(k);
    return {
      totals: {
        imagesBytes: facts.images.reduce((n, i) => n + i.sizeBytes, 0),
        containers: facts.containers.length,
        volumesBytes: facts.volumes.reduce((n, v) => n + (v.sizeBytes ?? 0), 0),
      },
      keepVersions: k,
      volumes,
      images,
      reclaimable: {
        volumes: summarizeReclaimable(volumes),
        images: summarizeReclaimable(images),
      },
    };
  }

  private cached: { at: number; value: StorageSummary } | null = null;
  private computing: Promise<StorageSummary> | null = null;

  async summary(now = Date.now()): Promise<StorageSummary> {
    if (this.cached && now - this.cached.at < SUMMARY_FRESH_MS)
      return this.cached.value;
    this.computing ??= this.report(1)
      .then((r) => ({
        imagesBytes: r.totals.imagesBytes,
        volumesBytes: r.totals.volumesBytes,
        containers: r.totals.containers,
        reclaimableImagesBytes: r.reclaimable.images.provable,
        reclaimableVolumesBytes: r.reclaimable.volumes.provable,
        topVolumes: [...r.volumes]
          .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
          .slice(0, TOP)
          .map((v) => ({
            name: v.name,
            sizeBytes: v.sizeBytes ?? 0,
            app: v.app,
            inUse: v.usedBy.length > 0,
          })),
        topImages: [...r.images]
          .sort((a, b) => b.sizeBytes - a.sizeBytes)
          .slice(0, TOP)
          .map((i) => ({
            name: i.tags[0] ?? i.id.replace(/^sha256:/, '').slice(0, 12),
            sizeBytes: i.sizeBytes,
            kind: i.kind,
            app: i.app,
            deletable: i.delete === 'yes',
          })),
      }))
      .finally(() => {
        this.computing = null;
      });
    const value = await this.computing;
    this.cached = { at: Date.now(), value };
    return value;
  }

  /**
   * Deletes the images that can be proved safe: not in use by any container, not an app's current or kept version,
   * not the platform's own. Never one that needs the caller to confirm they know what it is.
   */
  async pruneImages(): Promise<{
    deleted: number;
    freedBytes: number;
    skipped: number;
  }> {
    const { images } = await this.classify(1);
    const sure = images.filter((i) => i.delete === 'yes');
    const r = await this.deleteImages(
      sure.map((i) => i.id),
      1,
      false,
    );
    const gone = new Set(r.deleted);
    this.cached = null;
    return {
      deleted: r.deleted.length,
      freedBytes: sure
        .filter((i) => gone.has(i.id))
        .reduce((n, i) => n + i.sizeBytes, 0),
      skipped: r.skipped.length,
    };
  }

  /**
   * Deletes the named volumes, one by one. Facts are read again and every volume re-classified right now, so a
   * volume that became in use since the report was shown is skipped, whatever the caller was told earlier.
   */
  async deleteVolumes(
    names: string[],
    acknowledgeUnknownOwner: boolean,
  ): Promise<DeleteResult> {
    const { volumes } = await this.classify(1);
    const byName = new Map(volumes.map((v) => [v.name, v]));
    const result: DeleteResult = { deleted: [], skipped: [] };
    for (const name of [...new Set(names)]) {
      const item = byName.get(name);
      const skip = (reason: string) =>
        result.skipped.push({ id: name, reason });
      if (!item) skip('It does not exist (any more).');
      else if (item.delete === 'no') skip(item.reason);
      else if (item.delete === 'acknowledge' && !acknowledgeUnknownOwner)
        skip(
          'We cannot show this is ours: confirm that you know what it is to delete it.',
        );
      else
        try {
          await this.docker.removeVolume(name);
          result.deleted.push(name);
        } catch (e) {
          skip(e instanceof Error ? e.message : 'Docker refused.');
        }
    }
    return result;
  }

  /** What is inside a volume, listed read-only by a throwaway container with no network. */
  async peek(name: string): Promise<{ listing: string }> {
    const known = (await this.docker.volumeFacts(false)).some(
      (v) => v.name === name,
    );
    if (!known) throw new NotFoundError('That volume does not exist.');
    const r = await this.docker.runHelper({
      image: this.cfg.HELPER_IMAGE,
      // top level only, capped: enough to recognise what it is without dumping a big volume
      command: ['sh', '-c', 'ls -la /x | head -200'],
      mounts: [{ volume: name, target: '/x', readOnly: true }],
    });
    if (r.exitCode !== 0)
      throw new ValidationError(
        `Could not read the volume: ${r.output.trim().slice(-200)}`,
      );
    return { listing: r.output };
  }

  async deleteImages(
    ids: string[],
    keepVersions: number,
    acknowledgeUnknownOwner: boolean,
  ): Promise<DeleteResult> {
    const { images } = await this.classify(this.parseKeep(keepVersions));
    const byId = new Map(images.map((i) => [i.id, i]));
    const result: DeleteResult = { deleted: [], skipped: [] };
    for (const id of [...new Set(ids)]) {
      const item = byId.get(id);
      const skip = (reason: string) => result.skipped.push({ id, reason });
      if (!item) skip('It does not exist (any more).');
      else if (item.delete === 'no') skip(item.reason);
      else if (item.delete === 'acknowledge' && !acknowledgeUnknownOwner)
        skip(
          'We cannot show this is ours: confirm that you know what it is to delete it.',
        );
      else
        try {
          await this.docker.removeImage(id);
          result.deleted.push(id);
        } catch (e) {
          skip(e instanceof Error ? e.message : 'Docker refused.');
        }
    }
    return result;
  }
}
