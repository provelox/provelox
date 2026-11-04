import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DOCKER } from '../src/docker/docker.port';
import { FakeDocker } from '../src/docker/fake-docker';
import { RegistryClient } from '../src/image-updates/registry-client';
import { configure } from '../src/main';
import { RELEASE_FETCH } from '../src/system/release-check.service';

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('Release check (HTTP)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token: string;
  let latest = '0.5.1';
  const asked: string[] = [];
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const mk = async (scope: string) =>
    (
      await http
        .post('/v1/system/access-tokens')
        .set(auth())
        .send({ name: `t-${scope}`, scope })
        .expect(201)
    ).body.token as string;

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
      ADMIN_PASSWORD: 'e2e-password',
      DATA_DIR: ':memory:',
      ROOT_DOMAIN: 'example.com',
      PROVELOX_VERSION: '0.5.0',
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DOCKER)
      .useValue(new FakeDocker())
      .overrideProvider(RegistryClient)
      .useValue({ tags: async () => [], digest: async () => null })
      .overrideProvider(RELEASE_FETCH)
      .useValue(async (url: string) => {
        asked.push(url);
        return new Response(
          JSON.stringify({
            tag_name: `v${latest}`,
            draft: false,
            prerelease: false,
            html_url: `https://github.com/provelox/provelox/releases/tag/v${latest}`,
          }),
          { status: 200 },
        );
      })
      .compile();
    app = configure(mod.createNestApplication({ bodyParser: false }));
    await app.init();
    http = request(app.getHttpServer());
    token = (
      await http.post('/v1/auth/login').send({ password: 'e2e-password' })
    ).body.token;
  });
  afterAll(async () => {
    delete process.env.PROVELOX_VERSION;
    await app.close();
  });

  it('is closed to anyone who is not signed in', async () => {
    await http.get('/v1/system/release').expect(401);
    await http.post('/v1/system/release/check').expect(401);
    await http
      .put('/v1/system/release/settings')
      .send({ enabled: false })
      .expect(401);
  });

  it('tells a signed-in admin that a newer release exists', async () => {
    const r = await http.get('/v1/system/release').set(auth()).expect(200);
    expect(r.body).toMatchObject({
      enabled: true,
      current: '0.5.0',
      latest: '0.5.1',
      updateAvailable: true,
      step: 'patch',
      careful: false,
      notesUrl: 'https://github.com/provelox/provelox/releases/tag/v0.5.1',
      error: null,
    });
    // the newest release, then (because it is newer than the one running) the list that holds the notes in between
    expect(asked).toEqual([
      'https://api.github.com/repos/provelox/provelox/releases/latest',
      'https://api.github.com/repos/provelox/provelox/releases?per_page=20',
    ]);
    expect(r.body.notes.map((n: { version: string }) => n.version)).toEqual([
      '0.5.1',
    ]);
  });

  it('leaves the notes out when asked (?notes=0), and still says how many there are', async () => {
    const full = await http.get('/v1/system/release').set(auth()).expect(200);
    expect(full.body.notes).toHaveLength(1);
    expect(full.body.noteCount).toBe(1);
    const lean = await http
      .get('/v1/system/release?notes=0')
      .set(auth())
      .expect(200);
    expect(lean.body.notes).toEqual([]);
    expect(lean.body.noteCount).toBe(1);
    expect(lean.body.latest).toBe('0.5.1');
  });

  it('lets a read token see it, and an operate token ask again, but neither change the setting', async () => {
    const read = await mk('read');
    const operate = await mk('operate');
    await http.get('/v1/system/release').set(auth(read)).expect(200);
    await http.post('/v1/system/release/check').set(auth(read)).expect(403);
    await http.post('/v1/system/release/check').set(auth(operate)).expect(202);
    for (const t of [read, operate, await mk('update')])
      await http
        .put('/v1/system/release/settings')
        .set(auth(t))
        .send({ enabled: false })
        .expect(403);
  });

  it('refuses a body that is not exactly { enabled: true | false }', async () => {
    for (const body of [{}, { enabled: 'no' }, { enabled: true, extra: 1 }, []])
      await http
        .put('/v1/system/release/settings')
        .set(auth())
        .send(body as object)
        .expect(400);
  });

  it('can be switched off by an admin: no more looking, and the log says so', async () => {
    const before = asked.length;
    const off = await http
      .put('/v1/system/release/settings')
      .set(auth())
      .send({ enabled: false })
      .expect(200);
    expect(off.body).toEqual({ enabled: false });
    const r = await http.get('/v1/system/release').set(auth()).expect(200);
    await http.post('/v1/system/release/check').set(auth()).expect(202);
    expect(r.body).toMatchObject({
      enabled: false,
      latest: null,
      updateAvailable: false,
    });
    expect(asked.length).toBe(before);
    await settle();
    const log = await http.get('/v1/activity').set(auth()).expect(200);
    const actions = log.body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain('platform.update-check.off');
    // asking again is a question, not a change
    expect(actions).not.toContain('platform.release.check');
  });

  it('can be switched on again', async () => {
    latest = '0.5.2';
    await http
      .put('/v1/system/release/settings')
      .set(auth())
      .send({ enabled: true })
      .expect(200);
    const r = await http.get('/v1/system/release').set(auth()).expect(200);
    expect(r.body).toMatchObject({ enabled: true, latest: '0.5.2' });
  });
});
