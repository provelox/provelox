import { makeStack } from '../test-utils';
import {
  FORCE_EVERY_MS,
  FRESH_MS,
  ImageUpdatesService,
  RETRY_MS,
} from './image-updates.service';
import type { ImageRef } from './image-ref';
import type { RegistryClient } from './registry-client';

const D1 = 'sha256:' + '1'.repeat(64);
const D2 = 'sha256:' + '2'.repeat(64);

class FakeClient {
  tagsByRepo: Record<string, string[]> = {};
  digests: Record<string, string | null> = {};
  fail = new Set<string>();
  /** Holds every answer back until released, like a slow registry */
  gate: Promise<void> | null = null;
  tagCalls: string[] = [];
  digestCalls: string[] = [];
  async tags(ref: ImageRef) {
    this.tagCalls.push(`${ref.registry}/${ref.repo}`);
    await this.gate;
    if (this.fail.has(ref.repo))
      throw new Error(`${ref.registry} has no ${ref.repo}`);
    return this.tagsByRepo[ref.repo] ?? [];
  }
  async digest(ref: ImageRef, tag: string) {
    this.digestCalls.push(`${ref.repo}:${tag}`);
    return this.digests[`${ref.repo}:${tag}`] ?? null;
  }
}

async function setup() {
  const s = makeStack();
  const client = new FakeClient();
  const make = () =>
    new ImageUpdatesService(
      s.repo,
      s.settings,
      s.registries,
      s.docker,
      client as unknown as RegistryClient,
    );
  await s.apps.create({ name: 'web' });
  await s.apps.deploy('web', 'acme/web:1.4.0');
  await s.apps.create({ name: 'db' });
  await s.apps.deploy('db', 'mysql:8');
  await s.apps.create({ name: 'shop' });
  await s.apps.deploy('shop', 'acme/web:1.4.0'); // the same image as web
  return { ...s, client, svc: make(), make };
}

describe('ImageUpdatesService', () => {
  it('has no answer at first, then fills in behind the request', async () => {
    const { svc, client } = await setup();
    client.tagsByRepo['acme/web'] = ['1.4.0', '1.4.1', '1.5.0'];
    let release!: () => void;
    client.gate = new Promise<void>((r) => (release = r));
    const first = await svc.report();
    expect(first.updates.find((u) => u.app === 'web')).toMatchObject({
      latest: null,
      checkedAt: null,
    });
    expect(first.checking).toBe(true);
    release();
    await svc.refresh();
    const second = await svc.report();
    expect(second.checking).toBe(false);
    expect(second.updates.find((u) => u.app === 'web')).toMatchObject({
      image: 'acme/web:1.4.0',
      latest: { tag: '1.5.0', kind: 'minor' },
      error: null,
    });
  });

  it('does not list tags for a tag that cannot be compared, but still looks for a rebuild', async () => {
    const { svc, client } = await setup();
    await svc.refresh();
    expect(client.tagCalls).not.toContain('docker.io/library/mysql');
    expect(client.digestCalls).toContain('library/mysql:8');
  });

  it('checks one image once, however many apps use it, and lists a repository’s tags once', async () => {
    const { svc, client } = await setup();
    await svc.refresh();
    expect(
      client.tagCalls.filter((c) => c === 'docker.io/acme/web'),
    ).toHaveLength(1);
    expect(
      client.digestCalls.filter((c) => c === 'acme/web:1.4.0'),
    ).toHaveLength(1);
    const r = await svc.report();
    expect(r.updates.filter((u) => u.image === 'acme/web:1.4.0')).toHaveLength(
      2,
    );
  });

  it('answers from the cache until it is old, and keeps it through a restart', async () => {
    const { svc, client, make } = await setup();
    const t = Date.now();
    await svc.refresh(t);
    const calls = client.tagCalls.length;
    await svc.report(t + 1000);
    await svc.refresh(t + 1000);
    expect(client.tagCalls).toHaveLength(calls);
    // a new instance of the service (a restart) reads the saved answers
    const again = make();
    await again.report(t + 2000);
    await again.refresh(t + 2000);
    expect(client.tagCalls).toHaveLength(calls);
    // past its freshness it asks again
    await svc.refresh(t + FRESH_MS + 1000);
    expect(client.tagCalls.length).toBeGreaterThan(calls);
  });

  it('says when a tag was rebuilt: the registry holds another build than the one running', async () => {
    const { svc, client, docker } = await setup();
    client.digests['library/mysql:8'] = D2;
    docker.digests.set('pvx-db', D1);
    await svc.refresh();
    const db = (await svc.report()).updates.find((u) => u.app === 'db')!;
    expect(db.rebuilt).toBe(true);
    // once it runs the new build, there is nothing to say, without asking the registry again
    docker.digests.set('pvx-db', D2);
    expect(
      (await svc.report()).updates.find((u) => u.app === 'db')!.rebuilt,
    ).toBe(false);
  });

  it('does not guess when it does not know what is running', async () => {
    const { svc, client } = await setup();
    client.digests['library/mysql:8'] = D2;
    await svc.refresh();
    expect(
      (await svc.report()).updates.find((u) => u.app === 'db')!.rebuilt,
    ).toBe(false);
  });

  it('reports a registry that cannot be read, and tries again sooner than for a good answer', async () => {
    const { svc, client } = await setup();
    client.fail.add('acme/web');
    const t = Date.now();
    await svc.refresh(t);
    const web = (await svc.report(t + 1)).updates.find((u) => u.app === 'web')!;
    expect(web.error).toContain('has no acme/web');
    expect(web.latest).toBeNull();
    const calls = client.tagCalls.length;
    await svc.refresh(t + 60_000);
    expect(client.tagCalls).toHaveLength(calls);
    client.fail.clear();
    await svc.refresh(t + RETRY_MS + 1000);
    expect(client.tagCalls.length).toBeGreaterThan(calls);
    expect(
      (await svc.report(t + RETRY_MS + 2000)).updates.find(
        (u) => u.app === 'web',
      )!.error,
    ).toBeNull();
  });

  it('can be told to ask again, but not more than once a minute', async () => {
    const { svc, client } = await setup();
    const t = Date.now();
    await svc.refresh(t);
    const calls = client.tagCalls.length;
    await svc.force(t + 1000);
    await svc.refresh();
    expect(client.tagCalls.length).toBeGreaterThan(calls);
    const after = client.tagCalls.length;
    await svc.force(t + 2000);
    await svc.refresh();
    expect(client.tagCalls).toHaveLength(after);
    await svc.force(t + 1000 + FORCE_EVERY_MS + 1);
    await svc.refresh();
    expect(client.tagCalls.length).toBeGreaterThan(after);
  });

  it('leaves out apps with nothing deployed or no tag to compare', async () => {
    const { svc, apps } = await setup();
    await apps.create({ name: 'empty' });
    const r = await svc.report();
    expect(r.updates.map((u) => u.app)).not.toContain('empty');
  });

  it('forgets images no app uses any more', async () => {
    const { svc, settings, apps } = await setup();
    await svc.refresh();
    expect(
      Object.keys(settings.get<Record<string, unknown>>('imageChecks')!),
    ).toContain('docker.io/library/mysql:8');
    await apps.remove('db');
    await svc.refresh(Date.now() + FRESH_MS * 2);
    expect(
      Object.keys(settings.get<Record<string, unknown>>('imageChecks')!),
    ).not.toContain('docker.io/library/mysql:8');
  });
});
