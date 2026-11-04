import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ActivityController } from './activity/activity.controller';
import { ActivityInterceptor } from './activity/activity.interceptor';
import { ActivityService } from './activity/activity.service';
import { AppsController } from './apps/apps.controller';
import { CdnController } from './cdn/cdn.controller';
import { SsoController, SsoPublicController } from './sso/sso.controller';
import { SsoService } from './sso/sso.service';
import { CdnService } from './cdn/cdn.service';
import { ClusterController } from './cluster/cluster.controller';
import { ClusterService } from './cluster/cluster.service';
import { ErrorPagesController } from './apps/error-pages.controller';
import { AppsRepo } from './apps/apps.repo';
import { AppsService } from './apps/apps.service';
import { DeploymentsService } from './apps/deployments.service';
import { UsageHistoryService } from './apps/usage-history.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { LogsController } from './apps/logs.controller';
import { StorageController } from './storage/storage.controller';
import { StorageService } from './storage/storage.service';
import { VolumeMigrationService } from './apps/volume-migration.service';
import { MountsService } from './apps/mounts.service';
import { VolumeDownloadService } from './apps/volume-download.service';
import { VolumeRestoreService } from './apps/volume-restore.service';
import { VolumeImportService } from './apps/volume-import.service';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { VolumesController } from './apps/volumes.controller';
import { DatabaseBackupService } from './database/database-backup.service';
import { DatabaseController } from './database/database.controller';
import { DatabaseImportService } from './database/database-import.service';
import { TemplatesController } from './templates/templates.controller';
import { TemplateSourcesService } from './templates/template-sources.service';
import { SecretsController } from './apps/secrets.controller';
import { SecretsService } from './apps/secrets.service';
import { CiController, CiKeysController } from './ci/ci.controller';
import { CiKeysService } from './ci/ci-keys.service';
import { RegistriesController } from './registries/registries.controller';
import { ImageUpdatesController } from './image-updates/image-updates.controller';
import { ImageUpdatesService } from './image-updates/image-updates.service';
import { RegistryClient } from './image-updates/registry-client';
import { RegistriesService } from './registries/registries.service';
import { AuthController } from './auth/auth.controller';
import { AccessTokensController } from './auth/access-tokens.controller';
import { AccessTokensService } from './auth/access-tokens.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { CONFIG, loadConfig } from './config/config';
import { Db } from './db/db';
import { DOCKER } from './docker/docker.port';
import { DockerodeAdapter } from './docker/dockerode.adapter';
import { GroupsController } from './groups/groups.controller';
import { GroupsService } from './groups/groups.service';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';
import { CertificatesController } from './proxy/certificates.controller';
import { CertificatesService } from './proxy/certificates.service';
import { ProxyService } from './proxy/proxy.service';
import { PlaceholderService } from './system/placeholder.service';
import { PlatformHostsService } from './system/platform-hosts.service';
import { SelfUpdateService } from './self/self-update';
import { HostProcessesService } from './system/host-processes.service';
import { SecurityController } from './security/security.controller';
import { SecurityService } from './security/security.service';
import { PlatformUsageService } from './system/platform-usage.service';
import { SettingsService } from './system/settings.service';
import { ReleaseController } from './system/release.controller';
import {
  RELEASE_FETCH,
  ReleaseCheckService,
} from './system/release-check.service';
import { HealthController, SystemController } from './system/system.controller';

@Module({
  controllers: [
    ActivityController,
    CdnController,
    SsoController,
    SsoPublicController,
    ImageUpdatesController,
    ReleaseController,
    HealthController,
    ClusterController,
    NotificationsController,
    AuthController,
    AccessTokensController,
    AppsController,
    CertificatesController,
    GroupsController,
    ProjectsController,
    ErrorPagesController,
    SecretsController,
    LogsController,
    VolumesController,
    DatabaseController,
    RegistriesController,
    CiKeysController,
    CiController,
    StorageController,
    TemplatesController,
    SystemController,
    SecurityController,
    ImportsController,
  ],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    {
      provide: Db,
      useFactory: (cfg: ReturnType<typeof loadConfig>) =>
        new Db(cfg.DATA_DIR === ':memory:' ? ':memory:' : cfg.DATA_DIR),
      inject: [CONFIG],
    },
    { provide: DOCKER, useClass: DockerodeAdapter },
    SettingsService,
    ClusterService,
    PlaceholderService,
    PlatformHostsService,
    SelfUpdateService,
    ReleaseCheckService,
    {
      provide: RELEASE_FETCH,
      useValue: (url: string, init: RequestInit) => fetch(url, init),
    },
    PlatformUsageService,
    HostProcessesService,
    SecurityService,
    CdnService,
    SsoService,
    ProxyService,
    CertificatesService,
    RegistriesService,
    TemplateSourcesService,
    ImageUpdatesService,
    { provide: RegistryClient, useFactory: () => new RegistryClient() },
    CiKeysService,
    SecretsService,
    StorageService,
    VolumeMigrationService,
    MountsService,
    VolumeDownloadService,
    VolumeRestoreService,
    DatabaseBackupService,
    DatabaseImportService,
    VolumeImportService,
    ImportsService,
    AuthService,
    AppsRepo,
    GroupsService,
    AppsService,
    DeploymentsService,
    UsageHistoryService,
    NotificationsService,
    ProjectsService,
    AccessTokensService,
    ActivityService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
