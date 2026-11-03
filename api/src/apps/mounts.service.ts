import { Inject, Injectable } from '@nestjs/common';
import { serviceName } from '../common/naming';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { AppsService } from './apps.service';
import { mountSource } from './service-spec';
import { VolumeMigrationService } from './volume-migration.service';

export interface MountView {
  containerPath: string;
  mode: 'rw' | 'ro';
  kind: 'volume' | 'bind';
  /** Bind mounts: the directory on the server */
  hostPath?: string;
  /** Volumes: the name the user chose, and what Docker calls it */
  volumeName?: string;
  dockerName?: string;
  mountpoint?: string;
  sizeBytes?: number;
  /** Volumes: false until the app has started once with it */
  created?: boolean;
}

export interface DetectedMountView {
  containerPath: string;
  kind: 'volume';
  /** The image created it itself: new and empty on every redeploy */
  anonymous: boolean;
  volumeName: string;
  mountpoint?: string;
  sizeBytes?: number;
}

/** What an app has mounted: what it declares, and what its image created behind its back. */
@Injectable()
export class MountsService {
  constructor(
    private readonly apps: AppsService,
    private readonly migration: VolumeMigrationService,
    @Inject(DOCKER) private readonly docker: DockerPort,
  ) {}

  async get(
    appName: string,
    withSizes: boolean,
  ): Promise<{ mounts: MountView[]; detected: DetectedMountView[] }> {
    const app = this.apps.getDefinition(appName);
    const volumes = new Map(
      (await this.docker.volumeFacts(withSizes)).map((v) => [v.name, v]),
    );

    const mounts = app.volumes.map((m): MountView => {
      if (!m.volumeName)
        return {
          containerPath: m.containerPath,
          mode: m.readOnly ? 'ro' : 'rw',
          kind: 'bind',
          hostPath: m.hostPath,
        };
      const dockerName = mountSource(app, m);
      const v = volumes.get(dockerName);
      return {
        containerPath: m.containerPath,
        mode: m.readOnly ? 'ro' : 'rw',
        kind: 'volume',
        volumeName: m.volumeName,
        dockerName,
        mountpoint: v?.mountpoint,
        sizeBytes: v?.sizeBytes,
        created: !!v,
      };
    });

    const detected = (await this.migration.detect(appName)).map(
      (d): DetectedMountView => ({
        containerPath: d.containerPath,
        kind: 'volume',
        anonymous: d.anonymous,
        volumeName: d.volume,
        mountpoint: volumes.get(d.volume)?.mountpoint,
        sizeBytes: volumes.get(d.volume)?.sizeBytes,
      }),
    );
    return { mounts, detected };
  }
}

export { serviceName };
