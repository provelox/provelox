import { loadConfig } from '../config/config';
import { Db } from '../db/db';
import { ActivityService } from './activity.service';

const cfg = (env: Record<string, string> = {}) =>
  loadConfig({
    JWT_SECRET: 'x'.repeat(40),
    ROOT_DOMAIN: 'example.com',
    ...env,
  });

const input = (action: string, target: string | null = 'api', ok = true) => ({
  actor: { kind: 'admin' as const, name: 'admin' },
  action,
  target,
  outcome: ok ? ('ok' as const) : ('failed' as const),
  status: ok ? 200 : 404,
  summary: '',
});

function make(
  env: Record<string, string> = {},
  over: Partial<ReturnType<typeof cfg>> = {},
) {
  const db = new Db(':memory:');
  const service = new ActivityService(db, { ...cfg(env), ...over });
  return { db, service };
}

describe('ActivityService', () => {
  afterEach(() => jest.useRealTimers());

  it('lists newest first and pages with a cursor', () => {
    const { service } = make();
    for (let i = 1; i <= 5; i++) service.record(input(`app.step${i}`));
    const first = service.list({ limit: 2 });
    expect(first.events.map((e) => e.action)).toEqual([
      'app.step5',
      'app.step4',
    ]);
    expect(first.next).toBe(first.events[1].id);
    const second = service.list({ limit: 2, before: first.next! });
    expect(second.events.map((e) => e.action)).toEqual([
      'app.step3',
      'app.step2',
    ]);
    const last = service.list({ limit: 2, before: second.next! });
    expect(last.events.map((e) => e.action)).toEqual(['app.step1']);
    expect(last.next).toBeNull();
  });

  it('filters by app, action group, actor, outcome and time', () => {
    const { service } = make();
    const t = (iso: string) => new Date(iso);
    service.record(input('app.deploy', 'api'), t('2030-01-01T10:00:00Z'));
    service.record(input('app.restart', 'web'), t('2030-01-02T10:00:00Z'));
    service.record(
      input('secret.set', 'api', false),
      t('2030-01-03T10:00:00Z'),
    );
    service.record(
      {
        ...input('app.deploy', 'api'),
        actor: { kind: 'ci', name: 'GitHub', app: 'api' },
      },
      t('2030-01-04T10:00:00Z'),
    );
    const actions = (q: Parameters<ActivityService['list']>[0]) =>
      service.list(q).events.map((e) => e.action);
    expect(actions({ app: 'api' })).toEqual([
      'app.deploy',
      'secret.set',
      'app.deploy',
    ]);
    expect(actions({ action: 'app' })).toEqual([
      'app.deploy',
      'app.restart',
      'app.deploy',
    ]);
    expect(actions({ action: 'app.deploy' })).toEqual([
      'app.deploy',
      'app.deploy',
    ]);
    // a group is a whole word: "app" is not the start of "application"
    service.record(input('application.thing'));
    expect(actions({ action: 'app' })).not.toContain('application.thing');
    expect(actions({ outcome: 'failed' })).toEqual(['secret.set']);
    expect(actions({ actor: 'GitHub' })).toEqual(['app.deploy']);
    expect(
      actions({ since: '2030-01-03T00:00:00Z', limit: 10 }).slice(-2),
    ).toEqual(['app.deploy', 'secret.set']);
    expect(service.actors()).toEqual(['GitHub', 'admin']);
  });

  it('treats % and _ in a filter as plain characters', () => {
    const { service } = make();
    service.record(input('app.deploy'));
    expect(service.list({ action: 'a%' }).events).toEqual([]);
    expect(service.list({ action: 'a_p' }).events).toEqual([]);
  });

  it('drops what is older than the retention', () => {
    const { service } = make({ ACTIVITY_RETENTION_DAYS: '30' });
    const now = new Date('2030-06-01T00:00:00Z');
    service.record(input('app.old'), new Date('2030-03-01T00:00:00Z'));
    service.record(input('app.recent'), new Date('2030-05-20T00:00:00Z'));
    service.prune(now);
    expect(service.list().events.map((e) => e.action)).toEqual(['app.recent']);
  });

  it('keeps no more than the cap, dropping the oldest', () => {
    const { service } = make({}, { ACTIVITY_MAX_EVENTS: 3 });
    for (let i = 1; i <= 7; i++) service.record(input(`app.step${i}`));
    service.prune();
    expect(service.list().events.map((e) => e.action)).toEqual([
      'app.step7',
      'app.step6',
      'app.step5',
    ]);
  });

  it('prunes by itself as events are written', () => {
    const { service } = make({}, { ACTIVITY_MAX_EVENTS: 50 });
    for (let i = 0; i < 400; i++) service.record(input('app.restart'));
    expect(service.list({ limit: 200 }).events.length).toBeLessThanOrEqual(200);
    // the sweep runs every 200 writes: never more than the cap plus one batch
    const total = (
      service['db'].raw.prepare('SELECT COUNT(*) AS n FROM activity').get() as {
        n: number;
      }
    ).n;
    expect(total).toBeLessThanOrEqual(50 + 200);
  });

  it('never throws when it cannot write', () => {
    const { db, service } = make();
    db.raw.exec('DROP TABLE activity');
    expect(() => service.record(input('app.deploy'))).not.toThrow();
  });
});
