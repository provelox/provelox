import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Db } from '../src/db/db';
import { DOCKER } from '../src/docker/docker.port';
import { FakeDocker } from '../src/docker/fake-docker';
import { RegistryClient } from '../src/image-updates/registry-client';
import { configure } from '../src/main';

// The log is written just after the answer has gone
const settle = () => new Promise((r) => setTimeout(r, 40));

const SECRET_VALUE = 'SECRET-VALUE-do-not-log-7731';
const ENV_VALUE = 'ENV-VALUE-do-not-log-4410';
const PASSWORD = 'basic-auth-pw-do-not-log-9915';
const REGISTRY_PW = 'registry-pw-do-not-log-2208';
const WEBHOOK_TOKEN = 'WEBHOOK-TOKEN-do-not-log-5562';

describe('Activity log (HTTP)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const events = async (query = '') => {
    await settle();
    const r = await http.get(`/v1/activity${query}`).set(auth()).expect(200);
    return r.body as {
      events: {
        id: number;
        action: string;
        target: string | null;
        outcome: string;
        status: number;
        summary: string;
        actor: { kind: string; name: string; scope?: string; app?: string };
      }[];
      next: number | null;
      actors: string[];
    };
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
      ADMIN_PASSWORD: 'e2e-password',
      DATA_DIR: ':memory:',
      ROOT_DOMAIN: 'example.com',
      ERROR_PAGES_SERVICE: 'pvx-api-errors@swarm',
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DOCKER)
      .useValue(new FakeDocker())
      .overrideProvider(RegistryClient)
      .useValue({ tags: async () => ['1.0.0'], digest: async () => null })
      .compile();
    app = configure(mod.createNestApplication({ bodyParser: false }));
    await app.init();
    http = request(app.getHttpServer());
    token = (
      await http.post('/v1/auth/login').send({ password: 'e2e-password' })
    ).body.token;
  });
  afterAll(() => app.close());

  it('records who changed what, with the outcome', async () => {
    await http.post('/v1/apps').set(auth()).send({ name: 'shop' }).expect(201);
    await http
      .post('/v1/apps/shop/deploy')
      .set(auth())
      .send({ image: 'acme/shop:3.1' })
      .expect(202);
    await http
      .post('/v1/apps/ghost/deploy')
      .set(auth())
      .send({ image: 'acme/x:1' })
      .expect(404);

    const log = await events();
    const byAction = (a: string) => log.events.filter((e) => e.action === a);
    expect(byAction('app.create')[0]).toMatchObject({
      target: 'shop',
      outcome: 'ok',
      actor: { kind: 'admin', name: 'admin' },
    });
    expect(
      byAction('app.deploy').find((e) => e.target === 'shop'),
    ).toMatchObject({
      outcome: 'ok',
      summary: 'acme/shop:3.1',
    });
    // a refused change is in the log too, as failed with its status
    expect(
      byAction('app.deploy').find((e) => e.target === 'ghost'),
    ).toMatchObject({
      outcome: 'failed',
      status: 404,
    });
  });

  it('never stores a secret, a variable value, a password or a token anywhere', async () => {
    await http.post('/v1/apps').set(auth()).send({ name: 'vault' }).expect(201);
    await http
      .put('/v1/apps/vault/secrets/DB_PASSWORD')
      .set(auth())
      .send({ value: SECRET_VALUE })
      .expect(200);
    await http
      .patch('/v1/apps/vault')
      .set(auth())
      .send({ env: [{ key: 'API_URL', value: ENV_VALUE }] })
      .expect(200);
    await http
      .patch('/v1/apps/vault')
      .set(auth())
      .send({ basicAuth: { users: [{ name: 'ana', password: PASSWORD }] } });
    await http
      .post('/v1/registries')
      .set(auth())
      .send({ domain: 'ghcr.io', username: 'me', password: REGISTRY_PW });
    await http
      .post('/v1/system/notifications/webhooks')
      .set(auth())
      .send({ url: `https://hooks.example.com/services/${WEBHOOK_TOKEN}` });
    const made = await http
      .post('/v1/system/access-tokens')
      .set(auth())
      .send({ name: 'leak-probe', scope: 'read' })
      .expect(201);
    const ci = await http
      .post('/v1/ci-keys')
      .set(auth())
      .send({
        app: 'vault',
        name: 'probe-key',
        repository: 'ghcr.io/acme/vault',
      })
      .expect(201);

    const log = await events('?limit=200');
    const everything = JSON.stringify(log);
    for (const secret of [
      SECRET_VALUE,
      ENV_VALUE,
      PASSWORD,
      REGISTRY_PW,
      WEBHOOK_TOKEN,
      made.body.token,
      ci.body.key,
    ])
      expect(everything).not.toContain(secret);
    // and not in the database underneath
    const rows = JSON.stringify(
      app.get(Db).raw.prepare('SELECT * FROM activity').all(),
    );
    for (const secret of [
      SECRET_VALUE,
      ENV_VALUE,
      PASSWORD,
      REGISTRY_PW,
      WEBHOOK_TOKEN,
    ])
      expect(rows).not.toContain(secret);
    // what is there is the names
    const has = (action: string, part: string) =>
      log.events.some(
        (e) => e.action === action && (e.summary + e.target).includes(part),
      );
    expect(has('secret.set', 'DB_PASSWORD')).toBe(true);
    expect(has('app.env.update', 'API_URL')).toBe(true);
    expect(has('app.password.update', 'ana')).toBe(true);
    expect(has('notifications.webhook.add', 'hooks.example.com')).toBe(true);
  });

  it('shows an access token and a deploy key by name', async () => {
    await http
      .post('/v1/apps')
      .set(auth())
      .send({ name: 'ci-target' })
      .expect(201);
    await http
      .post('/v1/apps/ci-target/deploy')
      .set(auth())
      .send({ image: 'acme/ci:1' })
      .expect(202);
    const t = await http
      .post('/v1/system/access-tokens')
      .set(auth())
      .send({ name: 'the-hub', scope: 'operate' })
      .expect(201);
    await http
      .post('/v1/apps/ci-target/restart')
      .set(auth(t.body.token))
      .expect((r) => expect([200, 202, 204]).toContain(r.status));
    const key = await http
      .post('/v1/ci-keys')
      .set(auth())
      .send({
        app: 'ci-target',
        name: 'GitHub Actions',
        repository: 'acme/ci',
      })
      .expect(201);
    await http
      .post('/v1/ci/deploy')
      .set({ Authorization: `Bearer ${key.body.key}` })
      .send({ image: 'acme/ci:9' })
      .expect(202);

    const log = await events('?limit=200');
    expect(
      log.events.find(
        (e) => e.action === 'app.restart' && e.target === 'ci-target',
      )?.actor,
    ).toEqual({ kind: 'token', name: 'the-hub', scope: 'operate' });
    expect(
      log.events.find(
        (e) => e.action === 'app.deploy' && e.summary === 'acme/ci:9',
      )?.actor,
    ).toEqual({ kind: 'ci', name: 'GitHub Actions', app: 'ci-target' });
    expect(log.actors).toEqual(
      expect.arrayContaining(['admin', 'the-hub', 'GitHub Actions']),
    );
  });

  it('leaves out what is not a change, and what never got in', async () => {
    const before = (await events('?limit=200')).events.length;
    await http.get('/v1/apps').set(auth()).expect(200);
    await http.post('/v1/auth/login').send({ password: 'wrong' }).expect(401);
    await http.post('/v1/auth/login').send({ password: 'e2e-password' });
    await http
      .post('/v1/ci/deploy')
      .set({ Authorization: 'Bearer pvxk_0000000000000000_nope' })
      .send({ image: 'x/y:1' });
    await http.post('/v1/apps').send({ name: 'nobody' }).expect(401);
    await http
      .post('/v1/projects/preview')
      .set(auth())
      .send({ compose: 'services: {}' });
    const after = (await events('?limit=200')).events;
    expect(after.length).toBe(before);
    expect(after.some((e) => e.target === 'nobody')).toBe(false);
  });

  it('can be read only by the signed-in admin, never by an access token', async () => {
    for (const scope of ['read', 'operate', 'update']) {
      const t = await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: `reader-${scope}`, scope })
        .expect(201);
      await http.get('/v1/activity').set(auth(t.body.token)).expect(403);
    }
    await http.get('/v1/activity').expect(401);
    await http.get('/v1/activity').set(auth()).expect(200);
  });

  it('filters by app, action group, outcome and actor, and pages with a cursor', async () => {
    for (let i = 0; i < 6; i++)
      await http.post('/v1/apps/vault/restart').set(auth());
    const onVault = await events('?app=vault&limit=200');
    expect(onVault.events.length).toBeGreaterThan(6);
    expect(onVault.events.every((e) => e.target === 'vault')).toBe(true);

    const secrets = await events('?action=secret');
    expect(secrets.events.every((e) => e.action.startsWith('secret.'))).toBe(
      true,
    );
    const failed = await events('?outcome=failed&limit=200');
    expect(failed.events.length).toBeGreaterThan(0);
    expect(failed.events.every((e) => e.outcome === 'failed')).toBe(true);
    expect(
      (await events('?actor=the-hub')).events.every(
        (e) => e.actor.name === 'the-hub',
      ),
    ).toBe(true);

    const first = await events('?app=vault&limit=3');
    expect(first.events).toHaveLength(3);
    expect(first.next).not.toBeNull();
    const second = await events(`?app=vault&limit=3&before=${first.next}`);
    expect(second.events[0].id).toBeLessThan(first.events[2].id);
    const seen = new Set([...first.events, ...second.events].map((e) => e.id));
    expect(seen.size).toBe(6);

    await http.get('/v1/activity?limit=500').set(auth()).expect(400);
    await http.get('/v1/activity?action=%25').set(auth()).expect(400);
    await http.get('/v1/activity?bogus=1').set(auth()).expect(400);
  });
});
