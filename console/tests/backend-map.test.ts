import { describe, expect, it } from 'vitest';
import {
  toApiKey,
  toBackendPatch,
  toBuildStatus,
  toConsoleApp,
  toDeleteResults,
  toGroupsFile,
  toMigration,
  toStorageReport,
} from '@/lib/backend-map';
import type { BackendAppView } from '@/lib/backend-types';

const view = (
  over: Partial<BackendAppView['app']> = {},
  extra: Partial<BackendAppView> = {},
): BackendAppView => ({
  app: {
    name: 'files',
    persistent: true,
    image: 'acme/files:2',
    instanceCount: 1,
    exposed: true,
    containerPort: 3000,
    forceSsl: false,
    defaultSubdomain: true,
    defaultSubdomainSsl: false,
    domains: [{ host: 'files.org', ssl: true }],
    env: [{ key: 'A', value: '1' }],
    ports: [{ containerPort: 5432, hostPort: 15432, protocol: 'tcp' }],
    volumes: [
      { containerPath: '/data', volumeName: 'data', readOnly: false },
      { containerPath: '/in', hostPath: '/srv/in', readOnly: true },
    ],
    errorPages: { '502': '<h1>x</h1>' },
    secrets: [{ name: 'TOKEN', createdAt: '2026-01-01T00:00:00Z' }],
    groupId: null,
    deployVersion: 2,
    versions: [
      { version: 2, image: 'acme/files:2', deployedAt: '2026-01-02T00:00:00Z' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  },
  status: { desired: 1, running: 1, state: 'running' },
  hosts: [],
  ...extra,
});

describe('toConsoleApp', () => {
  it('carries the project an app belongs to, so the page can refuse to delete it alone', () => {
    expect(toConsoleApp(view({ project: 'blog' })).project).toBe('blog');
    expect(toConsoleApp(view()).project).toBeUndefined();
  });
  it('treats an app Docker has no service for as failing, not quietly running', () => {
    expect(
      toConsoleApp(view({ instanceCount: 1 }, { status: null })).runState,
    ).toBe('failed');
    expect(
      toConsoleApp(view({ instanceCount: 0 }, { status: null })).runState,
    ).toBe('stopped');
  });
  it('carries the secrets Docker no longer holds', () => {
    expect(
      toConsoleApp(view({}, { missingSecrets: ['A_KEY'] })).missingSecrets,
    ).toEqual(['A_KEY']);
    expect(toConsoleApp(view()).missingSecrets).toEqual([]);
  });
  it('carries what Docker reports as the run state', () => {
    const a = toConsoleApp(
      view({}, { status: { desired: 1, running: 0, state: 'failed' } }),
    );
    expect(a.runState).toBe('failed');
  });
  it('maps names and flags the pages use', () => {
    const a = toConsoleApp(view());
    expect(a).toMatchObject({
      appName: 'files',
      hasPersistentData: true,
      instanceCount: 1,
      deployedVersion: 2,
      notExposeAsWebApp: false,
      disableDefaultSubDomain: false,
      containerHttpPort: 3000,
      hasDefaultSubDomainSsl: false,
      forceSsl: false,
    });
  });
  it('inverts the exposure and default-subdomain flags', () => {
    const a = toConsoleApp(view({ exposed: false, defaultSubdomain: false }));
    expect(a.notExposeAsWebApp).toBe(true);
    expect(a.disableDefaultSubDomain).toBe(true);
  });
  it('maps domains, ports, secrets, env, error pages and versions', () => {
    const a = toConsoleApp(view());
    expect(a.customDomain).toEqual([
      { publicDomain: 'files.org', hasSsl: true },
    ]);
    expect(a.ports).toEqual([
      { containerPort: 5432, hostPort: 15432, protocol: 'tcp' },
    ]);
    expect(a.secrets).toEqual([
      { name: 'TOKEN', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(a.envVars).toEqual([{ key: 'A', value: '1' }]);
    expect(a.customErrorPages).toEqual({ '502': '<h1>x</h1>' });
    expect(a.versions).toEqual([
      {
        version: 2,
        timeStamp: '2026-01-02T00:00:00Z',
        deployedImageName: 'acme/files:2',
      },
    ]);
  });
  it('maps read-only to a mode string and keeps bind mounts apart from volumes', () => {
    expect(toConsoleApp(view()).volumes).toEqual([
      {
        containerPath: '/data',
        volumeName: 'data',
        hostPath: undefined,
        mode: 'rw',
      },
      {
        containerPath: '/in',
        volumeName: undefined,
        hostPath: '/srv/in',
        mode: 'ro',
      },
    ]);
  });
  it('shows a deploy in progress', () => {
    expect(toConsoleApp(view({}, { building: true })).isAppBuilding).toBe(true);
    expect(toConsoleApp(view()).isAppBuilding).toBe(false);
  });
});

describe('toBackendPatch', () => {
  it('maps the editable fields to the backend names', () => {
    expect(
      toBackendPatch({
        disableDefaultSubDomain: true,
        instanceCount: 3,
        containerHttpPort: 8080,
        forceSsl: true,
        envVars: [{ key: 'B', value: '2' }],
      }),
    ).toEqual({
      defaultSubdomain: false,
      instanceCount: 3,
      containerPort: 8080,
      forceSsl: true,
      env: [{ key: 'B', value: '2' }],
    });
  });
  it('sends the primary address, and null to stop redirecting', () => {
    expect(toBackendPatch({ primaryDomain: 'www.a.org' })).toEqual({
      primaryDomain: 'www.a.org',
    });
    expect(toBackendPatch({ primaryDomain: null })).toEqual({
      primaryDomain: null,
    });
  });
  it('maps ports (defaulting to tcp) and volumes (mode → readOnly)', () => {
    const p = toBackendPatch({
      ports: [
        { containerPort: 1, hostPort: 2 },
        { containerPort: 3, hostPort: 4, protocol: 'udp', publishMode: 'host' },
      ],
      volumes: [
        { containerPath: '/a', volumeName: 'v', mode: 'ro' },
        { containerPath: '/b', hostPath: '/srv/b' },
      ],
    });
    expect(p.ports).toEqual([
      { containerPort: 1, hostPort: 2, protocol: 'tcp' },
      { containerPort: 3, hostPort: 4, protocol: 'udp' },
    ]);
    expect(p.volumes).toEqual([
      { containerPath: '/a', volumeName: 'v', readOnly: true },
      { containerPath: '/b', hostPath: '/srv/b', readOnly: false },
    ]);
  });
  it('only sends what was given, and drops websocketSupport (the proxy always allows it)', () => {
    expect(toBackendPatch({})).toEqual({});
    expect(toBackendPatch({ websocketSupport: false })).toEqual({});
    expect(toBackendPatch({ instanceCount: 0 })).toEqual({ instanceCount: 0 });
  });
  it('is the inverse of toConsoleApp for ports, volumes and env', () => {
    const a = toConsoleApp(view());
    const patch = toBackendPatch({
      ports: a.ports,
      volumes: a.volumes,
      envVars: a.envVars,
    });
    expect(patch.ports).toEqual(view().app.ports);
    expect(patch.volumes).toEqual(view().app.volumes);
    expect(patch.env).toEqual(view().app.env);
  });
});

describe('other mappings', () => {
  it('toBuildStatus', () => {
    expect(
      toBuildStatus({ isBuilding: true, isFailed: false, lines: ['a', 'b'] }),
    ).toEqual({
      isAppBuilding: true,
      isBuildFailed: false,
      logs: { lines: ['a', 'b'], firstLineNumber: 0 },
    });
  });
  it('toMigration keeps the story and marks failures as rolled back', () => {
    const m = toMigration({
      app: 'files',
      containerPath: '/data',
      volumeName: 'data',
      from: 'abc',
      status: 'failed',
      log: ['one', 'two'],
      startedAt: '2026-01-01T00:00:00Z',
      error: 'nope',
    });
    expect(m).toMatchObject({
      status: 'failed',
      fromVolume: 'abc',
      toVolume: 'data',
      rolledBack: true,
      error: 'nope',
    });
    expect(m.steps.map((s) => s.text)).toEqual(['one', 'two']);
  });
  it('toGroupsFile', () => {
    expect(
      toGroupsFile([{ id: 'g_1', name: 'Shop', createdAt: '', apps: ['api'] }]),
    ).toEqual({
      groups: [{ id: 'g_1', name: 'Shop', appNames: ['api'] }],
    });
  });
  it('toApiKey', () => {
    expect(
      toApiKey({
        id: 'k',
        name: 'ci',
        app: 'site',
        createdAt: 'c',
        lastUsedAt: null,
        lastUsedImage: 'x:1',
      }),
    ).toEqual({
      id: 'k',
      name: 'ci',
      appName: 'site',
      createdAt: 'c',
      lastUsedAt: undefined,
      lastUsedImage: 'x:1',
    });
  });
  it('toStorageReport adds the zeroed build cache totals', () => {
    const r = toStorageReport({
      totals: { imagesBytes: 1, containers: 2, volumesBytes: 3 },
      keepVersions: 1,
      volumes: [],
      images: [],
      reclaimable: {
        volumes: { provable: 0, needsAck: 0 },
        images: { provable: 0, needsAck: 0 },
      },
    });
    expect(r.totals).toEqual({
      imagesBytes: 1,
      containers: 2,
      volumesBytes: 3,
      buildCacheBytes: 0,
      buildCacheReclaimableBytes: 0,
    });
  });
  it('toDeleteResults lists removals then refusals under the right key', () => {
    expect(
      toDeleteResults(
        { deleted: ['a'], skipped: [{ id: 'b', reason: 'in use' }] },
        'name',
      ),
    ).toEqual([
      { name: 'a', removed: true },
      { name: 'b', removed: false, reason: 'in use' },
    ]);
    expect(toDeleteResults({ deleted: ['i'], skipped: [] }, 'id')).toEqual([
      { id: 'i', removed: true },
    ]);
  });
});

import {
  toProjectDetail,
  toProjectPlan,
  toProjectSummary,
} from '@/lib/backend-map';
import type { BackendApp } from '@/lib/backend-types';

describe('project mappings', () => {
  const app = (name: string, over: Record<string, unknown> = {}) =>
    ({
      ...view().app,
      name,
      serviceAlias: name.split('-')[1],
      ...over,
    }) as unknown as BackendApp;

  it('toProjectPlan keeps one line per service and the issues', () => {
    const p = toProjectPlan({
      project: 'blog',
      changes: { create: ['blog-web'], update: [], remove: [] },
      apps: [
        app('blog-web', {
          exposed: true,
          image: 'wordpress:6',
          ports: [],
          volumes: [1, 2],
        }),
      ],
      volumes: ['site'],
      errors: [{ message: 'bad' }],
      warnings: [{ service: 'web', message: 'careful' }],
    });
    expect(p.services).toEqual([
      {
        app: 'blog-web',
        service: 'web',
        image: 'wordpress:6',
        public: true,
        ports: 0,
        volumes: 2,
      },
    ]);
    expect(p.errors).toEqual([{ message: 'bad' }]);
    expect(p.changes.create).toEqual(['blog-web']);
  });

  it('toProjectSummary names the services', () => {
    expect(
      toProjectSummary({ name: 'blog', updatedAt: 'u', apps: ['blog-web'] }),
    ).toEqual({
      name: 'blog',
      updatedAt: 'u',
      services: ['blog-web'],
    });
  });

  it('toProjectDetail reports status and the public host only for exposed services', () => {
    const d = toProjectDetail({
      name: 'blog',
      compose: 'services: {}',
      variableNames: ['DB_PASSWORD'],
      updatedAt: 'u',
      apps: [
        {
          app: app('blog-web', { exposed: true }),
          status: { desired: 1, running: 1, state: 'running' },
          hosts: [{ host: 'blog-web.example.com', ssl: false }],
        },
        { app: app('blog-db', { exposed: false }), status: null, hosts: [] },
      ],
    });
    expect(d.services[0]).toMatchObject({
      service: 'web',
      state: 'running',
      host: { host: 'blog-web.example.com', ssl: false },
    });
    expect(d.services[1]).toMatchObject({
      service: 'db',
      state: 'unknown',
      host: undefined,
    });
    expect(d.variableNames).toEqual(['DB_PASSWORD']);
  });
});

describe('runtime settings', () => {
  it('reads how the process runs from the API', () => {
    const app = toConsoleApp(
      view({
        command: ['node', 'server.js'],
        restart: 'on-failure',
        resources: { cpus: 1, memoryBytes: 268435456 },
        healthcheck: { test: ['CMD-SHELL', 'true'], retries: 3 },
      }),
    );
    expect(app.runtime).toMatchObject({
      command: ['node', 'server.js'],
      restart: 'on-failure',
      resources: { cpus: 1, memoryBytes: 268435456 },
      healthcheck: { test: ['CMD-SHELL', 'true'], retries: 3 },
    });
  });

  it('restarts always when the API names no policy', () => {
    expect(toConsoleApp(view()).runtime?.restart).toBe('any');
  });

  it('sends only what is given, and null to clear a setting', () => {
    expect(toBackendPatch({ command: null, restart: 'none' })).toEqual({
      command: null,
      restart: 'none',
    });
    expect(toBackendPatch({})).toEqual({});
  });

  it('carries the CDN an app sits behind both ways, and null removes it', () => {
    expect(
      toConsoleApp(view({ cdn: { provider: 'cloudfront', enforce: true } }))
        .cdn,
    ).toEqual({ provider: 'cloudfront', enforce: true });
    expect(toConsoleApp(view()).cdn).toBeUndefined();
    expect(
      toBackendPatch({ cdn: { provider: 'cloudflare', enforce: false } }),
    ).toEqual({ cdn: { provider: 'cloudflare', enforce: false } });
    expect(toBackendPatch({ cdn: null })).toEqual({ cdn: null });
    const sso = {
      provider: 'idp',
      emails: ['a@b.co'],
      domains: [],
      openPaths: [],
    };
    expect(toConsoleApp(view({ sso })).sso).toEqual(sso);
    expect(toConsoleApp(view()).sso).toBeUndefined();
    expect(toBackendPatch({ sso })).toEqual({ sso });
    expect(toBackendPatch({ sso: null })).toEqual({ sso: null });
  });
});

describe('what an update would do, and the values read back', () => {
  const plan = {
    project: 'upti',
    changes: { create: ['upti-inv'], update: ['upti-api'], remove: [] },
    apps: [] as BackendApp[],
    volumes: [],
    errors: [],
    warnings: [],
  };
  it('keeps the per-service changes, and tolerates an API that does not send them', () => {
    const diff = [
      {
        app: 'upti-api',
        service: 'api',
        action: 'restart' as const,
        reasons: ['environment: CORS_ORIGIN changed'],
        briefOutage: false,
        secretsChanged: [],
      },
    ];
    expect(toProjectPlan({ ...plan, diff }).diff).toEqual(diff);
    expect(toProjectPlan(plan).diff).toEqual([]);
  });
  it('a project detail carries the variables read back, from the template when an older API only sends those', () => {
    const v = {
      key: 'K',
      label: 'K',
      kind: 'secret' as const,
      value: 'x',
      where: 'the environment variable K',
    };
    const base = {
      name: 'upti',
      compose: '',
      variableNames: [],
      updatedAt: '',
      apps: [],
    };
    expect(toProjectDetail({ ...base, variables: [v] }).variables).toEqual([v]);
    expect(
      toProjectDetail({
        ...base,
        template: {
          id: 't',
          name: 'T',
          publicWeb: false,
          variables: [v],
          connection: {} as never,
        },
      }).variables,
    ).toEqual([v]);
    expect(toProjectDetail(base).variables).toEqual([]);
  });
});
