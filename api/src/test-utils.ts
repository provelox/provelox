import { loadConfig } from './config/config';
import { Db } from './db/db';
import { AppsRepo } from './apps/apps.repo';
import { AppsService } from './apps/apps.service';
import { FakeDocker } from './docker/fake-docker';
import { GroupsService } from './groups/groups.service';
import { ProjectsService } from './projects/projects.service';
import { PlaceholderService } from './system/placeholder.service';
import { ProxyService } from './proxy/proxy.service';
import { CiKeysService } from './ci/ci-keys.service';
import { VolumeMigrationService } from './apps/volume-migration.service';
import { MountsService } from './apps/mounts.service';
import { StorageService } from './storage/storage.service';
import { RegistriesService } from './registries/registries.service';
import { CdnService } from './cdn/cdn.service';
import { SsoService } from './sso/sso.service';
import { SettingsService } from './system/settings.service';
import { TemplateSourcesService } from './templates/template-sources.service';

/** A fully wired in-memory stack for service-level tests. */
/**
 * A whole API on in-memory parts. Tests mostly want apps to have their default address, so the platform's setting is
 * turned on here; pass `freshSettings` to leave it as a new install has it (off).
 */
export function makeStack(
  env: Record<string, string> = {},
  opts: { freshSettings?: boolean } = {},
) {
  const cfg = loadConfig({
    JWT_SECRET: 'x'.repeat(40),
    ROOT_DOMAIN: 'example.com',
    ACME_EMAIL: 'ops@example.com',
    ...env,
  });
  const db = new Db(':memory:');
  const docker = new FakeDocker();
  const settings = new SettingsService(db, cfg);
  if (!opts.freshSettings) settings.set('defaultSubdomainForNewApps', true);
  const repo = new AppsRepo(db);
  const groups = new GroupsService(db, repo);
  const placeholder = new PlaceholderService(settings, docker);
  const registries = new RegistriesService(db, docker, cfg);
  const ciKeys = new CiKeysService(db);
  const storage = new StorageService(repo, docker, cfg);
  const cdn = new CdnService(settings, repo, cfg);
  const sso = new SsoService(settings, repo, cfg);
  const apps = new AppsService(
    repo,
    docker,
    settings,
    groups,
    placeholder,
    registries,
    ciKeys,
    cfg,
    cdn,
    sso,
  );
  const migration = new VolumeMigrationService(apps, docker, cfg);
  migration.waitTimeoutMs = 200;
  migration.pollMs = 5;
  const mounts = new MountsService(apps, migration, docker);
  const proxy = new ProxyService(settings, docker, cfg, cdn);
  const templateSources = new TemplateSourcesService(db, cfg);
  const projects = new ProjectsService(
    db,
    repo,
    apps,
    groups,
    docker,
    templateSources,
  );
  projects.dependencyTimeoutMs = 50;
  projects.dependencyPollMs = 5;
  return {
    cfg,
    db,
    docker,
    settings,
    repo,
    groups,
    apps,
    projects,
    templateSources,
    placeholder,
    proxy,
    cdn,
    sso,
    registries,
    ciKeys,
    storage,
    migration,
    mounts,
  };
}
