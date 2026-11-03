import { RegistryClient } from '../src/image-updates/registry-client';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DOCKER } from '../src/docker/docker.port';
import { FakeDocker } from '../src/docker/fake-docker';
import { configure } from '../src/main';

const COMPOSE = `
services:
  web:
    image: acme/web:1
    depends_on: [db]
  db:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
`;

describe('Provelox API (HTTP)', () => {
  let app: INestApplication;
  let docker: FakeDocker;
  let http: ReturnType<typeof request>;
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
      ADMIN_PASSWORD: 'e2e-password',
      DATA_DIR: ':memory:',
      ROOT_DOMAIN: 'example.com',
      ERROR_PAGES_SERVICE: 'pvx-api-errors@swarm',
    });
    docker = new FakeDocker();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DOCKER)
      .useValue(docker)
      // never reach a real registry from a test
      .overrideProvider(RegistryClient)
      .useValue({
        tags: async () => ['1.0.0', '1.1.0'],
        digest: async () => null,
      })
      .compile();
    app = configure(mod.createNestApplication({ bodyParser: false }));
    await app.init();
    http = request(app.getHttpServer());
    const res = await http
      .post('/v1/auth/login')
      .send({ password: 'e2e-password' });
    token = res.body.token;
  });
  afterAll(() => app.close());

  describe('auth', () => {
    it('serves health without a token', async () => {
      await http.get('/health').expect(200, { status: 'ok' });
    });
    it('rejects requests without or with a bad token', async () => {
      const r = await http.get('/v1/apps').expect(401);
      expect(r.body.error.code).toBe('unauthorized');
      await http
        .get('/v1/apps')
        .set('Authorization', 'Bearer nope')
        .expect(401);
    });
    it('rejects a wrong password', async () => {
      await http.post('/v1/auth/login').send({ password: 'wrong' }).expect(401);
    });
    it('reports a good token', async () => {
      await http
        .get('/v1/auth/me')
        .set(auth())
        .expect(200, { authenticated: true });
    });
  });

  describe('apps', () => {
    it('runs a full lifecycle', async () => {
      const created = await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'site', defaultSubdomain: true })
        .expect(201);
      expect(created.body.app.name).toBe('site');
      expect(created.body.hosts).toEqual([
        { host: 'site.example.com', ssl: false },
      ]);

      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'site' })
        .expect(409);

      const patched = await http
        .patch('/v1/apps/site')
        .set(auth())
        .send({ instanceCount: 2, env: [{ key: 'A', value: '1' }] })
        .expect(200);
      expect(patched.body.app.instanceCount).toBe(2);

      const dep = await http
        .post('/v1/apps/site/deploy')
        .set(auth())
        .send({ image: 'nginx:1.27' })
        .expect(202);
      expect(dep.body.app.deployVersion).toBe(1);
      await new Promise((r) => setTimeout(r, 30));
      const status = await http
        .get('/v1/apps/site/deployment')
        .set(auth())
        .expect(200);
      expect(status.body).toMatchObject({ isBuilding: false, isFailed: false });

      const list = await http.get('/v1/apps').set(auth()).expect(200);
      expect(
        list.body.map((v: { app: { name: string } }) => v.app.name),
      ).toContain('site');

      await http.delete('/v1/apps/site').set(auth()).expect(200);
      await http.get('/v1/apps/site').set(auth()).expect(404);
      expect(docker.services.has('pvx-site')).toBe(false);
    });

    it('uses one error shape and refuses forbidden fields', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'Bad Name' })
        .expect(400);
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'locked' })
        .expect(201);
      const r = await http
        .patch('/v1/apps/locked')
        .set(auth())
        .send({ persistent: true })
        .expect(400);
      expect(r.body.error.code).toBe('invalid');
      const nf = await http.get('/v1/apps/ghost').set(auth()).expect(404);
      expect(nf.body.error).toMatchObject({ code: 'not_found' });
      await http.delete('/v1/apps/locked').set(auth());
    });
  });

  describe('groups', () => {
    it('creates, assigns, lists and deletes', async () => {
      const g = await http
        .post('/v1/groups')
        .set(auth())
        .send({ name: 'Shop' })
        .expect(201);
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'shop-api', groupId: g.body.id })
        .expect(201);
      const list = await http.get('/v1/groups').set(auth()).expect(200);
      expect(list.body[0]).toMatchObject({
        name: 'Shop',
        apps: ['shop-api'],
      });
      await http
        .post('/v1/groups')
        .set(auth())
        .send({ name: 'shop' })
        .expect(409);
      await http.delete(`/v1/groups/${g.body.id}`).set(auth()).expect(204);
      const app = await http.get('/v1/apps/shop-api').set(auth()).expect(200);
      expect(app.body.app.groupId).toBeNull();
      await http.delete('/v1/apps/shop-api').set(auth());
    });
  });

  describe('compose projects', () => {
    it('previews without changing anything', async () => {
      const before = docker.services.size;
      const r = await http
        .post('/v1/projects/preview')
        .set(auth())
        .send({ name: 'shop', compose: COMPOSE })
        .expect(201);
      expect(r.body.changes.create.sort()).toEqual(['shop-db', 'shop-web']);
      expect(r.body.errors).toEqual([]);
      expect(docker.services.size).toBe(before);
    });
    it('reports problems in a preview, not as a failure', async () => {
      const r = await http
        .post('/v1/projects/preview')
        .set(auth())
        .send({
          name: 'bad',
          compose: 'services:\n  a:\n    image: x\n    privileged: true',
        })
        .expect(201);
      expect(r.body.errors[0].message).toMatch(/Privileged/);
    });
    it('refuses to deploy a bad file with the reasons', async () => {
      const r = await http
        .post('/v1/projects')
        .set(auth())
        .send({ name: 'bad', compose: 'services:\n  a:\n    build: .' })
        .expect(400);
      expect(r.body.error.details[0].message).toMatch(/Building images/);
    });
    it('deploys, shows and removes a project', async () => {
      const d = await http
        .post('/v1/projects')
        .set(auth())
        .send({ name: 'shop', compose: COMPOSE })
        .expect(201);
      expect(d.body.apps.map((a: { name: string }) => a.name)).toEqual([
        'shop-db',
        'shop-web',
      ]);
      const g = await http.get('/v1/projects/shop').set(auth()).expect(200);
      expect(g.body.apps).toHaveLength(2);
      expect(
        (await http.get('/v1/groups').set(auth())).body.some(
          (x: { name: string }) => x.name === 'shop',
        ),
      ).toBe(false); // a project is its own container: no group is made for it

      await http.delete('/v1/apps/shop-web').set(auth()).expect(409); // belongs to a project
      const rm = await http.delete('/v1/projects/shop').set(auth()).expect(200);
      expect(rm.body.keptVolumes).toEqual(['pvx-shop-pgdata']);
      await http.get('/v1/projects/shop').set(auth()).expect(404);
    });
  });

  describe('system', () => {
    it('reports info and changes the root domain, re-applying apps', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'dom', defaultSubdomain: true })
        .expect(201);
      const info = await http.get('/v1/system/info').set(auth()).expect(200);
      expect(info.body).toMatchObject({
        rootDomain: 'example.com',
        docker: 'ok',
      });
      expect(typeof info.body.httpPort).toBe('number');
      expect(typeof info.body.httpsPort).toBe('number');
      await http
        .put('/v1/system/domain')
        .set(auth())
        .send({ rootDomain: 'apps.acme.dev' })
        .expect(200);
      const a = await http.get('/v1/apps/dom').set(auth()).expect(200);
      expect(a.body.hosts[0].host).toBe('dom.apps.acme.dev');
      expect(
        docker.services.get('pvx-dom')?.Labels[
          'traefik.http.routers.dom-web.rule'
        ],
      ).toContain('dom.apps.acme.dev');
      await http
        .put('/v1/system/domain')
        .set(auth())
        .send({ rootDomain: 'not a domain' })
        .expect(400);
      await http.delete('/v1/apps/dom').set(auth());
    });

    it('serves apps under their own domain while the platform keeps the root domain', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'sep', defaultSubdomain: true })
        .expect(201);
      const set = await http
        .put('/v1/system/apps-domain')
        .set(auth())
        .send({ appsDomain: 'app.hostname.com' })
        .expect(200);
      expect(set.body).toMatchObject({
        appsDomain: 'app.hostname.com',
        appsDomainCustom: true,
      });
      const info = await http.get('/v1/system/info').set(auth()).expect(200);
      expect(info.body).toMatchObject({
        rootDomain: 'apps.acme.dev',
        appsDomain: 'app.hostname.com',
      });
      expect(
        (await http.get('/v1/apps/sep').set(auth())).body.hosts[0].host,
      ).toBe('sep.app.hostname.com');
      expect(
        docker.services.get('pvx-sep')?.Labels[
          'traefik.http.routers.sep-web.rule'
        ],
      ).toContain('sep.app.hostname.com');
      const sum = await http.get('/v1/system/summary').set(auth()).expect(200);
      expect(sum.body.appsDomain).toBe('app.hostname.com');
      expect(
        sum.body.apps.find((x: { name: string }) => x.name === 'sep'),
      ).toMatchObject({
        defaultHost: 'sep.app.hostname.com',
        defaultAddress: true,
      });
      await http
        .put('/v1/system/apps-domain')
        .set(auth())
        .send({ appsDomain: 'not a domain' })
        .expect(400);
      // back to the root domain
      await http
        .put('/v1/system/apps-domain')
        .set(auth())
        .send({ appsDomain: null })
        .expect(200);
      expect(
        (await http.get('/v1/apps/sep').set(auth())).body.hosts[0].host,
      ).toBe('sep.apps.acme.dev');
      await http.delete('/v1/apps/sep').set(auth());
    });
  });

  describe('password protection for an app', () => {
    it('is set by the admin, kept as a hash, and put in the proxy routing', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'zzauth', defaultSubdomain: true })
        .expect(201);
      const r = await http
        .patch('/v1/apps/zzauth')
        .set(auth())
        .send({
          basicAuth: {
            users: [{ name: 'secure', password: 'a long password' }],
            openPaths: ['/hook'],
          },
        })
        .expect(200);
      expect(JSON.stringify(r.body)).not.toContain('a long password');
      const labels = docker.services.get('pvx-zzauth')?.Labels ?? {};
      expect(
        labels['traefik.http.middlewares.zzauth-auth.basicauth.users'],
      ).toMatch(/^secure:\$2[aby]\$08\$/);
      expect(labels['traefik.http.routers.zzauth-open-web.rule']).toContain(
        'PathPrefix(`/hook`)',
      );
      await http
        .patch('/v1/apps/zzauth')
        .set(auth())
        .send({ basicAuth: { users: [{ name: 'x', password: 'short' }] } })
        .expect(400);
      await http
        .patch('/v1/apps/zzauth')
        .set(auth())
        .send({ basicAuth: null })
        .expect(200);
      expect(
        docker.services.get('pvx-zzauth')?.Labels[
          'traefik.http.middlewares.zzauth-auth.basicauth.users'
        ],
      ).toBeUndefined();
      await http.delete('/v1/apps/zzauth').set(auth());
    });
  });

  describe('console and API over HTTPS', () => {
    it('reports where the platform is served, and only the admin can change it', async () => {
      const r = await http
        .get('/v1/system/platform-hosts')
        .set(auth())
        .expect(200);
      expect(r.body).toHaveProperty('console');
      expect(r.body).toHaveProperty('api');
      // the admin may ask; with no platform services here there is nothing to change (or no email to ask with yet)
      const done = await http.put('/v1/system/platform-https').set(auth());
      expect([200, 400]).toContain(done.status);
      const t = await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: 'https-probe', scope: 'update' })
        .expect(201);
      await http
        .get('/v1/system/platform-hosts')
        .set({ Authorization: `Bearer ${t.body.token}` })
        .expect(403);
      await http
        .put('/v1/system/platform-https')
        .set({ Authorization: `Bearer ${t.body.token}` })
        .expect(403);
    });
  });

  describe('cluster', () => {
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const machine = (id: string, hostname: string, role: string) => ({
      id,
      hostname,
      role,
      state: 'ready',
      availability: 'active',
      address: `10.0.0.${id.length}`,
      cpus: 2,
      memoryBytes: 1e9,
      os: 'linux',
      architecture: 'x86_64',
      dockerVersion: '27',
    });

    it('shows the machines, how to join another, and takes one out of service, for the admin only', async () => {
      const before = docker.nodes;
      docker.nodes = [
        machine('a', 'atl-1', 'leader'),
        machine('b', 'dfw-1', 'worker'),
      ] as never;
      try {
        const o = await http.get('/v1/system/cluster').set(auth()).expect(200);
        expect(
          o.body.nodes.map((n: { hostname: string }) => n.hostname),
        ).toEqual(['atl-1', 'dfw-1']);
        expect(o.body.canJoin).toBe(true);
        const j = await http
          .get('/v1/system/cluster/join')
          .set(auth())
          .expect(200);
        expect(j.body.worker.swarmCommand).toContain(
          'docker swarm join --token',
        );
        await http
          .post('/v1/system/cluster/join/rotate')
          .set(auth())
          .send({ role: 'worker' })
          .expect(201);
        await http
          .post('/v1/system/cluster/join/rotate')
          .set(auth())
          .send({ role: 'x' })
          .expect(400);
        // refusals are explained
        const refused = await http
          .patch('/v1/system/cluster/nodes/a')
          .set(auth())
          .send({ role: 'worker' })
          .expect(409);
        expect(JSON.stringify(refused.body)).toMatch(/API talks to/);
        await http
          .patch('/v1/system/cluster/nodes/b')
          .set(auth())
          .send({ availability: 'drain' })
          .expect(200);
        await http
          .patch('/v1/system/cluster/nodes/b')
          .set(auth())
          .send({})
          .expect(400);
        // a machine that is up has to leave the cluster itself first
        await http.delete('/v1/system/cluster/nodes/b').set(auth()).expect(409);
        (docker.nodes[1] as { state: string }).state = 'down';
        await http.delete('/v1/system/cluster/nodes/b').set(auth()).expect(200);
        // joining a machine gives it the Swarm: no access token may do any of this
        const t = await http
          .post('/v1/system/access-tokens')
          .set(auth())
          .send({ name: 'cluster-probe', scope: 'update' })
          .expect(201);
        for (const [m, path] of [
          ['get', '/v1/system/cluster'],
          ['get', '/v1/system/cluster/join'],
          ['post', '/v1/system/cluster/join/rotate'],
          ['patch', '/v1/system/cluster/nodes/a'],
          ['delete', '/v1/system/cluster/nodes/a'],
        ] as const)
          await http[m](path).set(bearer(t.body.token)).send({}).expect(403);
        await http.get('/v1/system/cluster').expect(401);
      } finally {
        docker.nodes = before;
      }
    });

    it('holds an app with local data to its machine, shows it, and lets only the admin release it', async () => {
      const before = docker.nodes;
      docker.nodes = [
        machine('a', 'atl-1', 'leader'),
        machine('b', 'dfw-1', 'worker'),
      ] as never;
      try {
        await http
          .post('/v1/apps')
          .set(auth())
          .send({ name: 'zzpin', persistent: true })
          .expect(201);
        docker.taskNodes.set('pvx-zzpin', 'b');
        await http
          .patch('/v1/apps/zzpin')
          .set(auth())
          .send({ volumes: [{ containerPath: '/data', volumeName: 'data' }] })
          .expect(200);
        const v = await http.get('/v1/apps/zzpin').set(auth()).expect(200);
        expect(v.body.pinnedTo).toBe('dfw-1');
        expect(
          docker.services.get('pvx-zzpin')?.TaskTemplate.Placement.Constraints,
        ).toEqual(['node.id==b']);
        const t = await http
          .post('/v1/system/access-tokens')
          .set(auth())
          .send({ name: 'pin-probe', scope: 'update' })
          .expect(201);
        await http
          .post('/v1/apps/zzpin/release-pin')
          .set(bearer(t.body.token))
          .expect(403);
        await http.post('/v1/apps/zzpin/release-pin').set(auth()).expect(204);
        const after = await http.get('/v1/apps/zzpin').set(auth()).expect(200);
        expect(after.body.pinnedTo).toBeNull();
        await http.delete('/v1/apps/zzpin').set(auth());
      } finally {
        docker.nodes = before;
      }
    });

    it('places an app on a machine of the cluster', async () => {
      const before = docker.nodes;
      docker.nodes = [
        machine('a', 'atl-1', 'leader'),
        machine('b', 'dfw-1', 'worker'),
      ] as never;
      try {
        await http
          .post('/v1/apps')
          .set(auth())
          .send({ name: 'zzplace' })
          .expect(201);
        const r = await http
          .patch('/v1/apps/zzplace')
          .set(auth())
          .send({ placement: { node: 'dfw-1' } })
          .expect(200);
        expect(r.body.app.placement).toEqual({ node: 'dfw-1' });
        expect(
          docker.services.get('pvx-zzplace')?.TaskTemplate.Placement
            .Constraints,
        ).toEqual(['node.hostname==dfw-1']);
        await http
          .patch('/v1/apps/zzplace')
          .set(auth())
          .send({ placement: { node: 'nowhere' } })
          .expect(400);
        await http.delete('/v1/apps/zzplace').set(auth());
      } finally {
        docker.nodes = before;
      }
    });
  });

  describe('app defaults', () => {
    it('lets the platform turn the default address off for new apps, and an app choose either way', async () => {
      const info = await http.get('/v1/system/info').set(auth()).expect(200);
      expect(info.body.defaultSubdomainForNewApps).toBe(false);
      await http
        .put('/v1/system/app-defaults')
        .set(auth())
        .send({ defaultSubdomain: false })
        .expect(200);
      const off = await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'nodefault' })
        .expect(201);
      expect(off.body.app.defaultSubdomain).toBe(false);
      expect(off.body.hosts).toEqual([]);
      const on = await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'withdefault', defaultSubdomain: true })
        .expect(201);
      expect(on.body.hosts).toHaveLength(1);
      await http
        .put('/v1/system/app-defaults')
        .set(auth())
        .send({ defaultSubdomain: 'no' })
        .expect(400);
      await http
        .put('/v1/system/app-defaults')
        .set(auth())
        .send({ defaultSubdomain: true })
        .expect(200);
      await http.delete('/v1/apps/nodefault').set(auth());
      await http.delete('/v1/apps/withdefault').set(auth());
    });
  });

  describe('notifications', () => {
    it('refuses a webhook that points at a cloud metadata or link-local address', async () => {
      for (const url of [
        'http://169.254.169.254/latest/meta-data/',
        'http://[fe80::1]/x',
        'http://metadata.google.internal/',
      ])
        await http
          .post('/v1/system/notifications/webhooks')
          .set(auth())
          .send({ name: 'Bad', url })
          .expect(400);
    });

    it('keeps webhooks (shown by host only) and chooses which events are sent', async () => {
      const first = await http
        .get('/v1/system/notifications')
        .set(auth())
        .expect(200);
      expect(first.body.events).toEqual({
        problem: true,
        recovered: true,
        certificate: true,
      });
      const added = await http
        .post('/v1/system/notifications/webhooks')
        .set(auth())
        .send({
          name: 'Chat',
          url: 'https://hooks.example.com/services/SECRET-PATH',
        })
        .expect(201);
      expect(added.body.host).toBe('hooks.example.com');
      const listed = await http
        .get('/v1/system/notifications')
        .set(auth())
        .expect(200);
      expect(JSON.stringify(listed.body)).not.toContain('SECRET-PATH');
      expect(listed.body.webhooks).toHaveLength(1);
      await http
        .put('/v1/system/notifications/events')
        .set(auth())
        .send({ recovered: false })
        .expect(200);
      await http
        .post('/v1/system/notifications/webhooks')
        .set(auth())
        .send({ name: 'x', url: 'not a url' })
        .expect(400);
      await http.get('/v1/system/notifications').expect(401);
      await http
        .delete(`/v1/system/notifications/webhooks/${added.body.id}`)
        .set(auth())
        .expect(204);
      const after = await http
        .get('/v1/system/notifications')
        .set(auth())
        .expect(200);
      expect(after.body.webhooks).toEqual([]);
      expect(after.body.events.recovered).toBe(false);
    });
  });

  describe('secrets', () => {
    it('writes and lists names only, never the value', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'sec' }).expect(201);
      const put = await http
        .put('/v1/apps/sec/secrets/API_TOKEN')
        .set(auth())
        .send({ value: 'top-secret-value' })
        .expect(200);
      expect(put.body.map((x: { name: string }) => x.name)).toEqual([
        'API_TOKEN',
      ]);
      const list = await http
        .get('/v1/apps/sec/secrets')
        .set(auth())
        .expect(200);
      expect(JSON.stringify(list.body)).not.toContain('top-secret-value');
      const detail = await http.get('/v1/apps/sec').set(auth()).expect(200);
      expect(JSON.stringify(detail.body)).not.toContain('top-secret-value');
      await http
        .put('/v1/apps/sec/secrets/bad%20name')
        .set(auth())
        .send({ value: 'x' })
        .expect(400);
      await http.put('/v1/apps/sec/secrets/X').set(auth()).send({}).expect(400);
      await http
        .delete('/v1/apps/sec/secrets/API_TOKEN')
        .set(auth())
        .expect(200);
      await http
        .delete('/v1/apps/sec/secrets/API_TOKEN')
        .set(auth())
        .expect(404);
      await http.delete('/v1/apps/sec').set(auth());
    });
  });

  describe('registries', () => {
    it('adds, lists without passwords, and rejects bad credentials', async () => {
      const added = await http
        .post('/v1/registries')
        .set(auth())
        .send({ domain: 'ghcr.io', username: 'me', password: 'tok-123' })
        .expect(201);
      expect(JSON.stringify(added.body)).not.toContain('tok-123');
      const list = await http.get('/v1/registries').set(auth()).expect(200);
      expect(list.body).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain('tok-123');
      await http
        .post('/v1/registries')
        .set(auth())
        .send({ domain: 'ghcr.io', username: 'me', password: 'x' })
        .expect(409);
      docker.rejectRegistry.add('bad.io');
      await http
        .post('/v1/registries')
        .set(auth())
        .send({ domain: 'bad.io', username: 'u', password: 'p' })
        .expect(400);
      await http
        .delete(`/v1/registries/${added.body.id}`)
        .set(auth())
        .expect(204);
      await http
        .delete(`/v1/registries/${added.body.id}`)
        .set(auth())
        .expect(404);
    });
  });

  describe('CI deploy keys', () => {
    it('lets a pipeline deploy its one app and nothing else', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'ci-app' })
        .expect(201);
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'other-app' })
        .expect(201);
      const created = await http
        .post('/v1/ci-keys')
        .set(auth())
        .send({ app: 'ci-app', name: 'GitHub' })
        .expect(201);
      const key = created.body.key as string;
      expect(key).toMatch(/^pvxk_/);

      // the key is not a session: it cannot call the admin API
      await http
        .get('/v1/apps')
        .set('Authorization', `Bearer ${key}`)
        .expect(401);

      const dep = await http
        .post('/v1/ci/deploy')
        .set('Authorization', `Bearer ${key}`)
        .send({ image: 'acme/ci:7' })
        .expect(202);
      expect(dep.body).toEqual({
        app: 'ci-app',
        version: 1,
        image: 'acme/ci:7',
      });
      expect(
        docker.services.get('pvx-ci-app')?.TaskTemplate.ContainerSpec.Image,
      ).toBe('acme/ci:7');
      expect(
        docker.services.get('pvx-other-app')?.TaskTemplate.ContainerSpec.Image,
      ).not.toBe('acme/ci:7');
      await new Promise((r) => setTimeout(r, 30));
      const st = await http
        .get('/v1/ci/deployment')
        .set('Authorization', `Bearer ${key}`)
        .expect(200);
      expect(st.body).toMatchObject({ isBuilding: false, isFailed: false });

      const list = await http
        .get('/v1/ci-keys?app=ci-app')
        .set(auth())
        .expect(200);
      expect(list.body[0]).toMatchObject({ lastUsedImage: 'acme/ci:7' });
      expect(JSON.stringify(list.body)).not.toContain(key.split('_')[2]);

      await http
        .post('/v1/ci/deploy')
        .set('Authorization', 'Bearer pvxk_nope')
        .send({ image: 'x:1' })
        .expect(401);
      await http.post('/v1/ci/deploy').send({ image: 'x:1' }).expect(401);
      await http
        .post('/v1/ci/deploy')
        .set('Authorization', `Bearer ${key}`)
        .send({})
        .expect(400);

      // deleting the app removes its keys, so a leaked key dies with it
      await http.delete('/v1/apps/ci-app').set(auth()).expect(200);
      await http
        .post('/v1/ci/deploy')
        .set('Authorization', `Bearer ${key}`)
        .send({ image: 'x:1' })
        .expect(401);
      expect((await http.get('/v1/ci-keys').set(auth())).body).toEqual([]);
      await http.delete('/v1/apps/other-app').set(auth());
    });
    it('revokes a key', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'rev-app' })
        .expect(201);
      const c = await http
        .post('/v1/ci-keys')
        .set(auth())
        .send({ app: 'rev-app', name: 'k' })
        .expect(201);
      await http
        .delete(`/v1/ci-keys/${c.body.info.id}`)
        .set(auth())
        .expect(204);
      await http
        .post('/v1/ci/deploy')
        .set('Authorization', `Bearer ${c.body.key}`)
        .send({ image: 'x:1' })
        .expect(401);
      await http
        .post('/v1/ci-keys')
        .set(auth())
        .send({ app: 'ghost', name: 'k' })
        .expect(404);
      await http.delete('/v1/apps/rev-app').set(auth());
    });
  });

  describe('logs', () => {
    it('returns the last lines as JSON and 404s for unknown apps', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'lg' }).expect(201);
      docker.logs.set(
        'pvx-lg',
        [1, 2, 3, 4, 5].map((n) => ({
          ts: `2026-01-01T00:00:0${n}Z`,
          stream: 'stdout' as const,
          text: `line ${n}`,
        })),
      );
      const r = await http
        .get('/v1/apps/lg/logs?tail=2')
        .set(auth())
        .expect(200);
      expect(r.body.map((l: { text: string }) => l.text)).toEqual([
        'line 4',
        'line 5',
      ]);
      await http.get('/v1/apps/ghost/logs').set(auth()).expect(404);
      await http.get('/v1/apps/lg/logs').expect(401);
      await http.delete('/v1/apps/lg').set(auth());
    });

    it('streams live lines as Server-Sent Events and stops when the client leaves', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'lv' }).expect(201);
      docker.logs.set('pvx-lv', [
        { ts: '', stream: 'stdout', text: 'history' },
      ]);
      await app.listen(0);
      const port = (app.getHttpServer().address() as { port: number }).port;
      const received: string[] = [];
      const req = await new Promise<import('node:http').ClientRequest>(
        (resolve) => {
          const r = require('node:http').get(
            {
              host: '127.0.0.1',
              port,
              path: '/v1/apps/lv/logs?follow=1&tail=10',
              headers: auth(),
            },
            (res: import('node:http').IncomingMessage) => {
              expect(res.headers['content-type']).toContain(
                'text/event-stream',
              );
              res.on('data', (c: Buffer) => received.push(c.toString()));
              resolve(r);
            },
          );
        },
      );
      await new Promise((r) => setTimeout(r, 100));
      docker.liveLogListeners.get('pvx-lv')?.({
        ts: '',
        stream: 'stderr',
        text: 'live line',
      });
      await new Promise((r) => setTimeout(r, 100));
      const body = received.join('');
      expect(body).toContain(
        'data: {"ts":"","stream":"stdout","text":"history"}',
      );
      expect(body).toContain('"text":"live line"');
      req.destroy();
      await new Promise((r) => setTimeout(r, 100));
      // the listener is released once the client has gone
      expect(docker.liveLogListeners.has('pvx-lv')).toBe(false);
      await http.delete('/v1/apps/lv').set(auth());
    });
  });

  describe('templates (ready-made apps)', () => {
    it('lists them without compose files, and returns one with its file', async () => {
      const list = await http.get('/v1/templates').set(auth()).expect(200);
      expect(list.body.map((t: { id: string }) => t.id)).toEqual(
        expect.arrayContaining(['postgres', 'wordpress']),
      );
      expect(JSON.stringify(list.body)).not.toContain('services:');
      const one = await http
        .get('/v1/templates/postgres')
        .set(auth())
        .expect(200);
      expect(one.body.compose).toContain('postgres:17');
      await http.get('/v1/templates/nope').set(auth()).expect(404);
      await http.get('/v1/templates').expect(401);
    });
    it('deploys a template as a project, making its web service public', async () => {
      const t = (await http.get('/v1/templates/wordpress').set(auth())).body;
      const variables = {
        DB_NAME: 'wp',
        DB_USER: 'wp',
        DB_PASSWORD: 'p4ss-xyz-123',
        DB_ROOT_PASSWORD: 'r00t-xyz-123',
      };
      const preview = await http
        .post('/v1/projects/preview')
        .set(auth())
        .send({ name: 'blog', compose: t.compose, variables })
        .expect(201);
      expect(preview.body.errors).toEqual([]);
      await http
        .post('/v1/projects')
        .set(auth())
        .send({ name: 'blog', compose: t.compose, variables })
        .expect(201);
      const web = await http
        .get('/v1/apps/blog-wordpress')
        .set(auth())
        .expect(200);
      expect(web.body.app.exposed).toBe(true);
      expect(web.body.hosts[0].host).toMatch(/^blog-wordpress\./);
      const db = await http.get('/v1/apps/blog-db').set(auth()).expect(200);
      expect(db.body.app.exposed).toBe(false);
      // the variable values are not kept with the project
      const proj = await http.get('/v1/projects/blog').set(auth()).expect(200);
      expect(JSON.stringify(proj.body.compose)).not.toContain('p4ss-xyz-123');
      await http.delete('/v1/projects/blog').set(auth()).expect(200);
    });
  });

  describe('default error pages', () => {
    it('serves the branded page for an app that set none, and its own where it did', async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'zzerr' })
        .expect(201);
      const dflt = await http
        .get('/internal/error-pages/zzerr/503')
        .expect(200);
      expect(dflt.text).toContain('not running right now');
      expect(dflt.headers['content-type']).toContain('text/html');
      // written by whoever may set it, shown at every address: styling only, no script
      expect(dflt.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(dflt.headers['content-security-policy']).toContain('sandbox');
      expect(dflt.headers['x-content-type-options']).toBe('nosniff');
      await http
        .patch('/v1/apps/zzerr')
        .set(auth())
        .send({ errorPages: { '503': '<h1>mine</h1>' } });
      expect((await http.get('/internal/error-pages/zzerr/503')).text).toBe(
        '<h1>mine</h1>',
      );
      expect(
        (await http.get('/internal/error-pages/zzerr/502')).text,
      ).toContain('did not give a valid answer');
    });
    it('answers an unknown address with a branded page and a real 404, without signing in', async () => {
      const r = await http.get('/internal/error-pages/not-found').expect(404);
      expect(r.text).toContain('Page not found');
      expect(r.headers['content-type']).toContain('text/html');
    });
    it('answers an unknown app like one with no page of its own, so the address does not say which apps exist, and still 404s an unknown status', async () => {
      const unknown = await http
        .get('/internal/error-pages/nope-app/503')
        .expect(200);
      expect(unknown.text).toContain('not running right now');
      await http.get('/internal/error-pages/zzerr/500').expect(404);
    });
  });

  describe('re-applying apps after the networks were lost', () => {
    it("recreates a project's network before starting its apps again", async () => {
      await http
        .post('/v1/projects')
        .set(auth())
        .send({
          name: 'zznet',
          compose: 'services:\n  web:\n    image: nginx:alpine\n',
          variables: {},
        })
        .expect(201);
      docker.networks.clear();
      await http
        .put('/v1/system/domain')
        .set(auth())
        .send({ rootDomain: 'again.example.com' })
        .expect(200);
      expect(docker.networks.has('pvx-net-zznet')).toBe(true);
      expect(docker.networks.has('provelox-net')).toBe(true);
    });
  });

  describe('host nodes', () => {
    it('lists the machines in the Swarm, signed in only', async () => {
      docker.nodes = [
        {
          id: 'n1',
          hostname: 'host-1',
          role: 'leader',
          state: 'ready',
          availability: 'active',
          address: '10.0.0.5',
          cpus: 8,
          memoryBytes: 8 * 1024 ** 3,
          os: 'linux',
          architecture: 'x86_64',
          dockerVersion: '28.1.1',
        },
      ];
      const r = await http.get('/v1/system/nodes').set(auth()).expect(200);
      expect(r.body).toEqual(docker.nodes);
      await http.get('/v1/system/nodes').expect(401);
    });
  });

  describe('fleet settings', () => {
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const mint = async (scope: string) =>
      (
        await http
          .post('/v1/system/access-tokens')
          .set(auth())
          .send({ name: `fleet ${scope}`, scope })
          .expect(201)
      ).body.token as string;

    it('keeps platform error pages, serves them to apps with none of their own, and reports a fingerprint', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'pg' }).expect(201);
      await http
        .put('/v1/system/error-pages')
        .set(auth())
        .send({ pages: { '502': '<p>fleet down</p>', '503': '   ' } })
        .expect(200, { pages: { '502': '<p>fleet down</p>' }, custom: true });
      const served = await http.get('/internal/error-pages/pg/502').expect(200);
      expect(served.text).toBe('<p>fleet down</p>');
      // no platform page for 504: the built-in one
      expect((await http.get('/internal/error-pages/pg/504')).text).toMatch(
        /Gateway|timeout/i,
      );
      // an app's own page wins
      await http
        .patch('/v1/apps/pg')
        .set(auth())
        .send({ errorPages: { '502': '<p>own</p>' } })
        .expect(200);
      expect((await http.get('/internal/error-pages/pg/502')).text).toBe(
        '<p>own</p>',
      );
      const sum = await http.get('/v1/system/summary').set(auth()).expect(200);
      expect(sum.body.fleet.errorPages).toMatch(/^[0-9a-f]{16}$/);
      expect(sum.body.fleet).toHaveProperty('placeholderPage');
      expect(typeof sum.body.fleet.defaultSubdomain).toBe('boolean');
      // putting nothing back restores the built-in pages and clears the fingerprint
      await http
        .put('/v1/system/error-pages')
        .set(auth())
        .send({ pages: {} })
        .expect(200, { pages: {}, custom: false });
      const after = await http
        .get('/v1/system/summary')
        .set(auth())
        .expect(200);
      expect(after.body.fleet.errorPages).toBeNull();
      await http.delete('/v1/apps/pg').set(auth());
    });

    it('lets an update token set them and a read token only look', async () => {
      const read = await mint('read');
      const operate = await mint('operate');
      const update = await mint('update');
      await http.get('/v1/system/error-pages').set(bearer(read)).expect(200);
      await http
        .get('/v1/system/placeholder-page')
        .set(bearer(read))
        .expect(200);
      for (const [tok, status] of [
        [read, 403],
        [operate, 403],
        [update, 200],
      ] as const) {
        await http
          .put('/v1/system/error-pages')
          .set(bearer(tok))
          .send({ pages: {} })
          .expect(status);
        await http
          .put('/v1/system/app-defaults')
          .set(bearer(tok))
          .send({ defaultSubdomain: false })
          .expect(status);
      }
    });

    it('lets an update token sync a template registry, reports it in the summary without its token, and keeps the rest admin-only', async () => {
      const { createServer } = await import('node:http');
      const index = JSON.stringify({
        name: 'Hub registry',
        templates: [
          {
            id: 'hub-tpl',
            name: 'Hub template',
            mainService: 'web',
            compose: 'services:\n  web:\n    image: nginx:alpine\n',
          },
        ],
      });
      const srv = createServer((_req, res) => res.end(index));
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/index.json`;
      try {
        const update = await mint('update');
        const operate = await mint('operate');
        const body = { kind: 'index', url, token: 'sekret-token' };
        await http
          .put('/v1/templates/sources/sync')
          .set(bearer(operate))
          .send(body)
          .expect(403);
        const added = await http
          .put('/v1/templates/sources/sync')
          .set(bearer(update))
          .send(body)
          .expect(200);
        expect(added.body).toMatchObject({
          name: 'Hub registry',
          templates: 1,
        });
        // sending it again updates the same registry
        const again = await http
          .put('/v1/templates/sources/sync')
          .set(bearer(update))
          .send({ kind: 'index', url, name: 'Renamed' })
          .expect(200);
        expect(again.body.id).toBe(added.body.id);
        const sum = await http
          .get('/v1/system/summary')
          .set(auth())
          .expect(200);
        expect(sum.body.fleet.templateRegistries).toContainEqual(
          expect.objectContaining({ kind: 'index', url, name: 'Renamed' }),
        );
        expect(JSON.stringify(sum.body)).not.toContain('sekret-token');
        // listing or removing is for the signed-in admin
        await http.get('/v1/templates/sources').set(bearer(update)).expect(403);
        await http
          .delete(`/v1/templates/sources/${added.body.id}`)
          .set(auth())
          .expect(204);
      } finally {
        await new Promise((r) => srv.close(r));
      }
    });

    it('lets an update token set a registry sign-in, lists registries in the summary without passwords, and keeps the rest admin-only', async () => {
      const update = await mint('update');
      const operate = await mint('operate');
      await http
        .put('/v1/registries/signin')
        .set(bearer(operate))
        .send({ domain: 'ghcr.io', username: 'hub', password: 'tok-1' })
        .expect(403);
      await http
        .put('/v1/registries/signin')
        .set(bearer(update))
        .send({ domain: 'ghcr.io', username: 'hub', password: 'tok-1' })
        .expect(200);
      const sum = await http.get('/v1/system/summary').set(auth()).expect(200);
      expect(sum.body.fleet.registries).toContainEqual({
        domain: 'ghcr.io',
        username: 'hub',
      });
      expect(JSON.stringify(sum.body)).not.toContain('tok-1');
      // reading the list or removing one is still for the signed-in admin
      await http.get('/v1/registries').set(bearer(update)).expect(403);
      const list = await http.get('/v1/registries').set(auth()).expect(200);
      for (const r of list.body)
        await http.delete(`/v1/registries/${r.id}`).set(auth());
    });

    it("lets an update token set the Let's Encrypt email and sync notifications, and reports both in the summary without addresses", async () => {
      const update = await mint('update');
      const operate = await mint('operate');
      for (const [path, body] of [
        ['/v1/system/acme-email', { email: 'ops@example.com' }],
        ['/v1/system/notifications/sync', { events: { certificate: false } }],
      ] as const)
        await http.put(path).set(bearer(operate)).send(body).expect(403);
      await http
        .put('/v1/system/acme-email')
        .set(bearer(update))
        .send({ email: 'fleet@example.com' })
        .expect(200);
      await http
        .put('/v1/system/notifications/sync')
        .set(bearer(update))
        .send({
          events: { certificate: false },
          webhooks: [
            { name: 'Team', url: 'https://hooks.example.com/secret-token' },
          ],
        })
        .expect(200);
      const sum = await http.get('/v1/system/summary').set(auth()).expect(200);
      expect(sum.body.fleet.acmeEmail).toBe('fleet@example.com');
      expect(sum.body.fleet.notifications.events.certificate).toBe(false);
      expect(sum.body.fleet.notifications.webhooks).toContainEqual(
        expect.objectContaining({ name: 'Team', host: 'hooks.example.com' }),
      );
      expect(JSON.stringify(sum.body)).not.toContain('secret-token');
      // the rest of the notification settings are still admin-only
      await http
        .get('/v1/system/notifications')
        .set(bearer(update))
        .expect(403);
    });

    it('lets an update token apply a blueprint, reports a fingerprint for the app, and refuses anything wider', async () => {
      const update = await mint('update');
      const operate = await mint('operate');
      const spec = { name: 'bp-app', image: 'nginx:alpine', containerPort: 80 };
      await http
        .put('/v1/system/blueprint')
        .set(bearer(operate))
        .send(spec)
        .expect(403);
      const r = await http
        .put('/v1/system/blueprint')
        .set(bearer(update))
        .send(spec)
        .expect(200);
      expect(r.body).toEqual({ name: 'bp-app', created: true, deployed: true });
      const sum = await http.get('/v1/system/summary').set(auth()).expect(200);
      const app = sum.body.apps.find(
        (x: { name: string }) => x.name === 'bp-app',
      );
      expect(app.blueprint).toMatch(/^[0-9a-f]{16}$/);
      expect(sum.body.fleet.blueprints).toBe(true);
      // a host directory, or anything not in the blueprint, is refused
      await http
        .put('/v1/system/blueprint')
        .set(bearer(update))
        .send({ ...spec, name: 'bp-bad', hostPath: '/etc' })
        .expect(400);
      await http.delete('/v1/apps/bp-app').set(auth());
    });

    it('refuses what is not a page set', async () => {
      await http
        .put('/v1/system/error-pages')
        .set(auth())
        .send({ pages: { '418': 'x' } })
        .expect(400);
      await http
        .put('/v1/system/error-pages')
        .set(auth())
        .send({ pages: { '502': 7 } })
        .expect(400);
    });
  });

  describe('summary: linked domain', () => {
    it('carries the name linked to an app, which is never one of its hosts', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'ns' }).expect(201);
      await http
        .patch('/v1/apps/ns')
        .set(auth())
        .send({ exposed: false, linkedDomain: 'ns1.example.org' })
        .expect(200);
      const sum = await http.get('/v1/system/summary').set(auth()).expect(200);
      const ns = sum.body.apps.find((x: { name: string }) => x.name === 'ns');
      expect(ns.linkedDomain).toBe('ns1.example.org');
      expect(ns.hosts).toEqual([]);
      await http.delete('/v1/apps/ns').set(auth());
    });
  });

  describe('platform services', () => {
    it('reports the API, proxy and console without them being apps', async () => {
      // The first reading is taken as the API starts, before the test's services exist; one with no reading is looked at
      // again after a moment, so wait that moment
      await new Promise((r) => setTimeout(r, 1100));
      const r = await http.get('/v1/system/services').set(auth()).expect(200);
      expect(r.body.map((x: { id: string }) => x.id)).toEqual([
        'api',
        'proxy',
        'console',
      ]);
      expect(
        r.body.every(
          (x: { installed: boolean }) => typeof x.installed === 'boolean',
        ),
      ).toBe(true);
      // an installed service has a reading of what it uses; one that is not installed has none
      for (const x of r.body as {
        installed: boolean;
        usage: { cpuPercent: number; memoryBytes: number } | null;
      }[])
        if (x.installed) expect(typeof x.usage?.cpuPercent).toBe('number');
        else expect(x.usage).toBeNull();
      const apps = await http.get('/v1/apps').set(auth()).expect(200);
      expect(
        apps.body.map((v: { app: { name: string } }) => v.app.name),
      ).not.toContain('console');
      await http.get('/v1/system/services').expect(401);
    });
    it("does not let a new app take the console's name", async () => {
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'console' })
        .expect(400);
    });
  });

  describe('moving data into a named volume', () => {
    it('detects, validates, starts and reports a move', async () => {
      const ANON = 'd'.repeat(64);
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'mv', persistent: true })
        .expect(201);
      docker.mounts.set('pvx-mv', [
        { type: 'volume', name: ANON, destination: '/data', readOnly: false },
      ]);
      const det = await http
        .get('/v1/apps/mv/volumes/detected')
        .set(auth())
        .expect(200);
      expect(det.body).toEqual([
        { containerPath: '/data', volume: ANON, anonymous: true },
      ]);

      await http.get('/v1/apps/mv/volumes/migration').set(auth()).expect(404);
      await http
        .post('/v1/apps/mv/volumes/migrate')
        .set(auth())
        .send({ containerPath: 'relative', volumeName: 'x' })
        .expect(400);
      await http
        .post('/v1/apps/mv/volumes/migrate')
        .set(auth())
        .send({ containerPath: '/nope', volumeName: 'x' })
        .expect(404);

      const started = await http
        .post('/v1/apps/mv/volumes/migrate')
        .set(auth())
        .send({ containerPath: '/data', volumeName: 'data' })
        .expect(202);
      expect(started.body).toMatchObject({
        app: 'mv',
        status: 'running',
        from: ANON,
      });
      // writes are refused while it runs
      await new Promise((r) => setTimeout(r, 20));
      const done = await http
        .get('/v1/apps/mv/volumes/migration')
        .set(auth())
        .expect(200);
      expect(['running', 'done']).toContain(done.body.status);
      await new Promise((r) => setTimeout(r, 1500));
      const end = await http
        .get('/v1/apps/mv/volumes/migration')
        .set(auth())
        .expect(200);
      expect(end.body.status).toBe('done');
      expect(docker.helperRuns.at(-1)?.mounts[0]).toMatchObject({
        volume: ANON,
        readOnly: true,
      });
      const app = await http.get('/v1/apps/mv').set(auth()).expect(200);
      expect(app.body.app.volumes).toEqual([
        { containerPath: '/data', volumeName: 'data', readOnly: false },
      ]);
      await http.get('/v1/apps/mv/volumes/detected').expect(401);
      await http.delete('/v1/apps/mv').set(auth());
    });
  });

  describe('proxy, placeholder page and error pages', () => {
    it("reports proxy status and sets the Let's Encrypt email", async () => {
      const st = await http.get('/v1/system/proxy').set(auth()).expect(200);
      expect(st.body).toMatchObject({ enabled: true, httpPort: 80 });
      await http
        .put('/v1/system/acme-email')
        .set(auth())
        .send({ email: 'nope' })
        .expect(400);
      await http
        .put('/v1/system/acme-email')
        .set(auth())
        .send({ email: 'ops@example.com' })
        .expect(200);
      expect(
        (await http.get('/v1/system/proxy').set(auth())).body.acmeEmail,
      ).toBe('ops@example.com');
    });
    it('sets a placeholder page and re-applies apps still on it', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'ph' }).expect(201);
      const before =
        docker.services.get('pvx-ph')?.TaskTemplate.ContainerSpec.Configs?.[0]
          .ConfigName;
      await http
        .put('/v1/system/placeholder-page')
        .set(auth())
        .send({ html: '<h1>Mine</h1>' })
        .expect(200);
      const after =
        docker.services.get('pvx-ph')?.TaskTemplate.ContainerSpec.Configs?.[0]
          .ConfigName;
      expect(after).not.toBe(before);
      const page = await http
        .get('/v1/system/placeholder-page')
        .set(auth())
        .expect(200);
      expect(page.body).toEqual({ html: '<h1>Mine</h1>', custom: true });
      await http
        .put('/v1/system/placeholder-page')
        .set(auth())
        .send({ html: '' })
        .expect(200);
      expect(
        (await http.get('/v1/system/placeholder-page').set(auth())).body.custom,
      ).toBe(false);
      await http.delete('/v1/apps/ph').set(auth());
    });
    it('serves custom error pages to the proxy, without a login', async () => {
      await http.post('/v1/apps').set(auth()).send({ name: 'err' }).expect(201);
      await http
        .patch('/v1/apps/err')
        .set(auth())
        .send({ errorPages: { '502': '<h1>Custom 502</h1>' } })
        .expect(200);
      const custom = await http
        .get('/internal/error-pages/err/502')
        .expect(200);
      expect(custom.headers['content-type']).toContain('text/html');
      expect(custom.text).toBe('<h1>Custom 502</h1>');
      expect(
        (await http.get('/internal/error-pages/err/503').expect(200)).text,
      ).toContain('Service unavailable');
      await http.get('/internal/error-pages/err/500').expect(404);
      // an app that does not exist is answered like one that has no page of its own
      await http.get('/internal/error-pages/ghost/502').expect(200);
      await http.get('/internal/error-pages/BAD..NAME/502').expect(200);
      await http.delete('/v1/apps/err').set(auth());
    });
  });

  describe('access tokens', () => {
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    let readToken: string;
    let operateToken: string;
    let readId: string;

    beforeAll(async () => {
      const r = await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: 'hub (read)', scope: 'read' })
        .expect(201);
      readToken = r.body.token;
      readId = r.body.info.id;
      const o = await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: 'hub (operate)', scope: 'operate' })
        .expect(201);
      operateToken = o.body.token;
      await http
        .post('/v1/apps')
        .set(auth())
        .send({ name: 'tok-app' })
        .expect(201);
      await http
        .post('/v1/apps/tok-app/deploy')
        .set(auth())
        .send({ image: 'nginx:alpine' })
        .expect(202);
    });

    it('lists tokens without their secrets', async () => {
      const r = await http
        .get('/v1/system/access-tokens')
        .set(auth())
        .expect(200);
      expect(r.body.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining(['hub (read)', 'hub (operate)']),
      );
      expect(JSON.stringify(r.body)).not.toContain(readToken.slice(-20));
    });

    it('lets a token roll an app to another version of its image, never to a different image', async () => {
      await http
        .post('/v1/apps/tok-app/deploy')
        .set(bearer(operateToken))
        .send({ image: 'nginx:1.27' })
        .expect(202);
      const refused = await http
        .post('/v1/apps/tok-app/deploy')
        .set(bearer(operateToken))
        .send({ image: 'attacker/miner:1' })
        .expect(403);
      expect(refused.body.message ?? refused.body.error).toBeDefined();
      // the same name under another registry is a different image
      await http
        .post('/v1/apps/tok-app/deploy')
        .set(bearer(operateToken))
        .send({ image: 'evil.example.com/nginx:1.27' })
        .expect(403);
      // an app that has no image yet cannot be given one by a token
      await http.post('/v1/apps').set(auth()).send({ name: 'tok-empty' });
      await http
        .post('/v1/apps/tok-empty/deploy')
        .set(bearer(operateToken))
        .send({ image: 'nginx:alpine' })
        .expect(403);
      await http.delete('/v1/apps/tok-empty').set(auth());
      // the admin may change the image itself
      await http
        .post('/v1/apps/tok-app/deploy')
        .set(auth())
        .send({ image: 'nginx:alpine' })
        .expect(202);
    });

    it('lets a read token look at status and nothing else', async () => {
      const sum = await http
        .get('/v1/system/summary')
        .set(bearer(readToken))
        .expect(200);
      expect(sum.body.apps.map((a: { name: string }) => a.name)).toContain(
        'tok-app',
      );
      expect(sum.body).toHaveProperty('nodes');
      expect(sum.body).toHaveProperty('services');
      await http.get('/v1/system/info').set(bearer(readToken)).expect(200);
      await http
        .get('/v1/apps/tok-app/usage')
        .set(bearer(readToken))
        .expect(200);
      // the full definition (environment, secrets), the list, settings and logs are for the admin
      for (const path of [
        '/v1/apps',
        '/v1/apps/tok-app',
        '/v1/apps/tok-app/secrets',
        '/v1/apps/tok-app/logs',
        '/v1/system/access-tokens',
        '/v1/system/notifications',
        '/v1/ci-keys',
      ]) {
        const r = await http.get(path).set(bearer(readToken)).expect(403);
        expect(r.body.error.code).toBe('forbidden');
      }
    });

    it('does not let a read token change anything', async () => {
      await http
        .post('/v1/apps/tok-app/restart')
        .set(bearer(readToken))
        .expect(403);
      await http
        .post('/v1/apps/tok-app/stop')
        .set(bearer(readToken))
        .expect(403);
      await http
        .put('/v1/system/domain')
        .set(bearer(readToken))
        .send({ rootDomain: 'evil.example.com' })
        .expect(403);
    });

    it('does not hand the environment back to an operate token in the answer to an action', async () => {
      await http
        .patch('/v1/apps/tok-app')
        .set(auth())
        .send({
          env: [{ key: 'DB_PASSWORD', value: 'hunter2-secret-value' }],
        })
        .expect(200);
      const t = bearer(operateToken);
      const answers = [
        await http.post('/v1/apps/tok-app/restart').set(t).expect(202),
        await http.post('/v1/apps/tok-app/reconcile').set(t),
        await http.post('/v1/apps/tok-app/stop').set(t).expect(202),
        await http.post('/v1/apps/tok-app/start').set(t).expect(202),
        await http
          .post('/v1/apps/tok-app/deploy')
          .set(t)
          .send({ image: 'nginx:alpine' })
          .expect(202),
      ];
      for (const a of answers) {
        expect(JSON.stringify(a.body)).not.toContain('hunter2-secret-value');
        expect(JSON.stringify(a.body)).not.toContain('DB_PASSWORD');
        expect(a.body.app.name).toBe('tok-app');
      }
      // the admin still gets the whole definition
      const full = await http
        .post('/v1/apps/tok-app/restart')
        .set(auth())
        .expect(202);
      expect(JSON.stringify(full.body)).toContain('DB_PASSWORD');
    });

    it('shows how an app is set up to a read token, without a single value', async () => {
      const r = await http
        .get('/v1/apps/tok-app/config')
        .set(bearer(readToken))
        .expect(200);
      expect(r.body.environment).toContain('DB_PASSWORD');
      expect(JSON.stringify(r.body)).not.toContain('hunter2-secret-value');
      await http.get('/v1/apps/tok-app/config').expect(401);
    });

    it('reports newer images to a read token and lets an operate token ask again', async () => {
      await http
        .post('/v1/apps/tok-app/deploy')
        .set(auth())
        .send({ image: 'acme/tok:1.0.0' })
        .expect(202);
      const t = bearer(operateToken);
      const r = await http
        .get('/v1/system/image-updates')
        .set(bearer(readToken))
        .expect(200);
      expect(Array.isArray(r.body.updates)).toBe(true);
      await http
        .post('/v1/system/image-updates/check')
        .set(bearer(readToken))
        .expect(403);
      await http.post('/v1/system/image-updates/check').set(t).expect(202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await http
        .get('/v1/system/image-updates')
        .set(bearer(readToken))
        .expect(200);
      const mine = again.body.updates.find(
        (u: { app: string }) => u.app === 'tok-app',
      );
      expect(mine).toMatchObject({
        image: 'acme/tok:1.0.0',
        latest: { tag: '1.1.0', kind: 'minor' },
      });
      await http.get('/v1/system/image-updates').expect(401);
      // put the image back for the tests that follow
      await http
        .post('/v1/apps/tok-app/deploy')
        .set(auth())
        .send({ image: 'nginx:alpine' })
        .expect(202);
    });

    it('lists what was deployed to a read token, and lets an operate token scale within limits', async () => {
      const v = await http
        .get('/v1/apps/tok-app/versions')
        .set(bearer(readToken))
        .expect(200);
      expect(v.body.current).toBeGreaterThan(0);
      expect(v.body.versions[0]).toMatchObject({ image: 'nginx:alpine' });
      expect(JSON.stringify(v.body)).not.toContain('DB_PASSWORD');
      const t = bearer(operateToken);
      await http
        .post('/v1/apps/tok-app/scale')
        .set(bearer(readToken))
        .send({ instances: 2 })
        .expect(403);
      const ok = await http
        .post('/v1/apps/tok-app/scale')
        .set(t)
        .send({ instances: 3 })
        .expect(202);
      expect(ok.body.app.instanceCount).toBe(3);
      expect(JSON.stringify(ok.body)).not.toContain('DB_PASSWORD');
      for (const bad of [0, 21, 1.5, '2', -1])
        await http
          .post('/v1/apps/tok-app/scale')
          .set(t)
          .send({ instances: bad })
          .expect(400);
      await http
        .post('/v1/apps/tok-app/scale')
        .set(t)
        .send({ instances: 2, image: 'evil' })
        .expect(400);
    });

    it('lets an operate token restart, stop and start, but not change settings or mint tokens', async () => {
      const t = bearer(operateToken);
      await http.post('/v1/apps/tok-app/restart').set(t).expect(202);
      await http.post('/v1/apps/tok-app/stop').set(t).expect(202);
      const stopped = await http.get('/v1/system/summary').set(t).expect(200);
      expect(
        stopped.body.apps.find((a: { name: string }) => a.name === 'tok-app')
          .state,
      ).toBe('stopped');
      await http.post('/v1/apps/tok-app/start').set(t).expect(202);
      await http.get('/v1/apps/tok-app/logs').set(t).expect(200);
      await http
        .put('/v1/system/domain')
        .set(t)
        .send({ rootDomain: 'x.example.com' })
        .expect(403);
      await http
        .post('/v1/system/access-tokens')
        .set(t)
        .send({ name: 'more', scope: 'operate' })
        .expect(403);
      await http.delete('/v1/apps/tok-app').set(t).expect(403);
    });

    it('tells a caller what its own token may do', async () => {
      const scope = async (token: string) =>
        (await http.get('/v1/system/summary').set(bearer(token)).expect(200))
          .body.tokenScope;
      expect(await scope(readToken)).toBe('read');
      expect(await scope(operateToken)).toBe('operate');
      const u = await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: 'whoami (update)', scope: 'update' })
        .expect(201);
      expect(await scope(u.body.token)).toBe('update');
      // a signed-in admin is not a token
      const admin = await http
        .get('/v1/system/summary')
        .set(auth())
        .expect(200);
      expect(admin.body.tokenScope).toBe('admin');
    });

    it('lets only an update token upgrade the platform', async () => {
      await http
        .post('/v1/system/update')
        .set(bearer(operateToken))
        .send({ version: '9.9.9' })
        .expect(403);
      const u = await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: 'hub (update)', scope: 'update' })
        .expect(201);
      const t = bearer(u.body.token);
      // Allowed in, then refused for what it asked: a bad body, and a platform that is not running as a service here
      await http.post('/v1/system/update').set(t).send({}).expect(400);
      await http
        .post('/v1/system/update')
        .set(t)
        .send({ version: 'latest' })
        .expect(400);
      await http.get('/v1/system/summary').set(t).expect(200);
    });

    it('does not scale a running app down when asked to start it', async () => {
      await http
        .patch('/v1/apps/tok-app')
        .set(auth())
        .send({ instanceCount: 3 })
        .expect(200);
      await http
        .post('/v1/apps/tok-app/start')
        .set(bearer(operateToken))
        .expect(202);
      const r = await http.get('/v1/apps/tok-app').set(auth()).expect(200);
      expect(r.body.app.instanceCount).toBe(3);
    });

    it('rejects a forged or revoked token', async () => {
      await http
        .get('/v1/system/summary')
        .set(bearer(`pvxt_${'0'.repeat(16)}_${'a'.repeat(43)}`))
        .expect(401);
      await http
        .delete(`/v1/system/access-tokens/${readId}`)
        .set(auth())
        .expect(204);
      await http.get('/v1/system/summary').set(bearer(readToken)).expect(401);
    });
  });

  it('changes the password and signs the old token out', async () => {
    await http
      .post('/v1/auth/change-password')
      .set(auth())
      .send({ oldPassword: 'e2e-password', newPassword: 'another-password' })
      .expect(201);
    await http.get('/v1/apps').set(auth()).expect(401);
    const re = await http
      .post('/v1/auth/login')
      .send({ password: 'another-password' })
      .expect(201);
    token = re.body.token;
    await http.get('/v1/apps').set(auth()).expect(200);
  });
});
