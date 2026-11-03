import { FakeDocker } from '../docker/fake-docker';
import type { SwarmServiceSpec } from '../apps/service-spec';
import { LABEL_APP, LABEL_MANAGED } from '../common/naming';
import {
  detach,
  isMovingTag,
  planDetach,
  planUninstall,
  uninstall,
} from './uninstall';

const svc = (app: string, labels: Record<string, string> = {}) =>
  ({
    Name: `pvx-${app}`,
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: app, ...labels },
  }) as unknown as SwarmServiceSpec;

/** What an app's routes look like: an errors step defined against the API's service, and an HTTPS redirect */
const routed = (app: string, extra: Record<string, string> = {}) => ({
  [`traefik.http.middlewares.${app}-errors.errors.status`]: '502-504',
  [`traefik.http.middlewares.${app}-errors.errors.service`]:
    'pvx_error_pages@swarm',
  [`traefik.http.middlewares.${app}-errors.errors.query`]: `/internal/error-pages/${app}/{status}`,
  [`traefik.http.middlewares.${app}-https.redirectscheme.scheme`]: 'https',
  [`traefik.http.routers.${app}-redirect.middlewares`]: `${app}-https`,
  [`traefik.http.routers.${app}-web.middlewares`]: `${app}-errors`,
  [`traefik.http.routers.${app}-websecure.middlewares`]: `cdn,${app}-errors`,
  ...extra,
});

function lab() {
  const docker = new FakeDocker();
  docker.services.set('pvx-console', svc('console'));
  docker.services.set('pvx-provelox', svc('provelox'));
  docker.services.set('pvx-traefik', svc('traefik'));
  docker.services.set('pvx-shop', svc('shop', routed('shop')));
  docker.services.set(
    'pvx-intranet',
    svc(
      'intranet',
      routed('intranet', {
        'traefik.http.middlewares.intranet-sso.forwardauth.address':
          'http://api/verify',
      }),
    ),
  );
  docker.services.set('pvx-plain', svc('plain'));
  docker.networks.set('provelox-net', { [LABEL_MANAGED]: 'true' });
  docker.networks.set('pvx-net-shop', {
    [LABEL_MANAGED]: 'true',
    'io.provelox.project': 'shop',
  });
  docker.networks.set('someone-elses', {});
  docker.volumes.set('pvx-provelox-data', { [LABEL_MANAGED]: 'true' });
  docker.volumes.set('pvx-shop-data', { [LABEL_MANAGED]: 'true' });
  docker.volumes.set('mine', {});
  docker.secrets.set('pvx-provelox-jwt', {
    value: 'x',
    labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: 'provelox' },
  });
  docker.secrets.set('pvx-shop-api-key', {
    value: 'x',
    labels: { [LABEL_MANAGED]: 'true', [LABEL_APP]: 'shop' },
  });
  docker.configs.set('pvx-phconf-1', 'x');
  return docker;
}

describe('planDetach', () => {
  it('takes the errors step out of the routes and out of the definitions, and keeps the rest', async () => {
    const plan = planDetach(await lab().managedObjects());
    const shop = plan.apps.find((a) => a.service === 'pvx-shop');
    const byLabel = Object.fromEntries(
      shop?.changes.map((c) => [c.label, c.to]) ?? [],
    );
    expect(byLabel['traefik.http.routers.shop-web.middlewares']).toBeNull();
    expect(byLabel['traefik.http.routers.shop-websecure.middlewares']).toBe(
      'cdn',
    );
    expect(
      byLabel['traefik.http.middlewares.shop-errors.errors.service'],
    ).toBeNull();
    // the redirect is not touched
    expect(Object.keys(byLabel).join()).not.toMatch(/shop-https|redirect/);
  });
  it('skips the platform and apps without such a step, and names the apps behind a sign-in', async () => {
    const plan = planDetach(await lab().managedObjects());
    expect(plan.apps.map((a) => a.service).sort()).toEqual([
      'pvx-intranet',
      'pvx-shop',
    ]);
    expect(plan.signIn).toEqual(['pvx-intranet']);
  });
});

describe('detach', () => {
  it('changes labels only, and leaves other labels as they were', async () => {
    const docker = lab();
    const done = await detach(
      docker,
      planDetach(await docker.managedObjects()),
    );
    expect(done.sort()).toEqual(['pvx-intranet', 'pvx-shop']);
    const labels = docker.services.get('pvx-shop')?.Labels ?? {};
    expect(labels['traefik.http.routers.shop-web.middlewares']).toBeUndefined();
    expect(labels['traefik.http.routers.shop-websecure.middlewares']).toBe(
      'cdn',
    );
    expect(labels['traefik.http.routers.shop-redirect.middlewares']).toBe(
      'shop-https',
    );
    expect(
      labels['traefik.http.middlewares.shop-https.redirectscheme.scheme'],
    ).toBe('https');
    expect(
      labels['traefik.http.middlewares.shop-errors.errors.service'],
    ).toBeUndefined();
    expect(planDetach(await docker.managedObjects()).apps).toEqual([]);
  });
});

describe('uninstall', () => {
  it('by default detaches, then removes only the console and the API', async () => {
    const docker = lab();
    const plan = planUninstall(await docker.managedObjects(), {
      removeApps: false,
      deleteData: false,
    });
    expect(plan.remove.map((r) => r.name)).toEqual([
      'pvx-console',
      'pvx-provelox',
    ]);
    await uninstall(docker, plan, async () => {});
    expect([...docker.services.keys()].sort()).toEqual([
      'pvx-intranet',
      'pvx-plain',
      'pvx-shop',
      'pvx-traefik',
    ]);
    expect(docker.volumes.size).toBe(3);
    expect(docker.secrets.size).toBe(2);
    expect(docker.networks.size).toBe(3);
    expect(
      docker.services.get('pvx-shop')?.Labels[
        'traefik.http.routers.shop-web.middlewares'
      ],
    ).toBeUndefined();
  });

  it('removes everything of ours but the volumes, and never what is not ours', async () => {
    const docker = lab();
    const plan = planUninstall(await docker.managedObjects(), {
      removeApps: true,
      deleteData: false,
    });
    // apps first, the proxy last among the services
    const services = plan.remove
      .filter((r) => r.kind === 'service')
      .map((r) => r.name);
    expect(services.slice(-3)).toEqual([
      'pvx-console',
      'pvx-provelox',
      'pvx-traefik',
    ]);
    expect(plan.keptVolumes.sort()).toEqual([
      'pvx-provelox-data',
      'pvx-shop-data',
    ]);
    const r = await uninstall(docker, plan, async () => {});
    expect(r.left).toEqual([]);
    expect(docker.services.size).toBe(0);
    // the platform's own secrets go (install makes them again); an app's stays, its value is nowhere else
    expect([...docker.secrets.keys()]).toEqual(['pvx-shop-api-key']);
    expect(plan.keptSecrets).toEqual(['pvx-shop-api-key']);
    expect(docker.configs.size).toBe(0);
    expect([...docker.networks.keys()]).toEqual(['someone-elses']);
    expect([...docker.volumes.keys()].sort()).toEqual([
      'mine',
      'pvx-provelox-data',
      'pvx-shop-data',
    ]);
  });

  it('--delete-data also removes our volumes, and still not yours', async () => {
    const docker = lab();
    const plan = planUninstall(await docker.managedObjects(), {
      removeApps: true,
      deleteData: true,
    });
    await uninstall(docker, plan, async () => {});
    expect([...docker.volumes.keys()]).toEqual(['mine']);
    expect(docker.secrets.size).toBe(0);
  });

  it('reports what Docker would not let go instead of stopping', async () => {
    const docker = lab();
    const remove = docker.removeManaged.bind(docker);
    docker.removeManaged = async (kind, name) => {
      if (name === 'pvx-net-shop')
        throw new Error('network has active endpoints');
      return remove(kind, name);
    };
    const plan = planUninstall(await docker.managedObjects(), {
      removeApps: true,
      deleteData: false,
    });
    const r = await uninstall(docker, plan, async () => {});
    expect(r.left).toEqual([
      'network pvx-net-shop: network has active endpoints',
    ]);
    expect(docker.networks.has('provelox-net')).toBe(false);
  });
});

describe('isMovingTag', () => {
  it('flags a tag that can name another image later', () => {
    for (const t of [
      'nginx',
      'nginx:latest',
      'ghcr.io/a/b:stable',
      'localhost:5001/demo/web:live',
    ])
      expect(isMovingTag(t)).toBe(true);
    for (const t of [
      'nginx:1.26-alpine',
      'redis:7.2',
      'ghcr.io/a/b:20261030-013846',
      '',
    ])
      expect(isMovingTag(t)).toBe(false);
  });
  it('a full uninstall lists the apps that stop; the default lists none', async () => {
    const docker = lab();
    const objects = await docker.managedObjects();
    const full = planUninstall(objects, {
      removeApps: true,
      deleteData: false,
    });
    expect(full.stops.map((s) => s.service).sort()).toEqual([
      'pvx-intranet',
      'pvx-plain',
      'pvx-shop',
    ]);
    expect(
      planUninstall(objects, { removeApps: false, deleteData: false }).stops,
    ).toEqual([]);
  });
});
