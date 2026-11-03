import { makeApp } from '../apps/test-fixtures';
import { diffPlan, diffService } from './plan-diff';

const app = (over: Parameters<typeof makeApp>[0] = {}) =>
  makeApp({ name: 'upti-api', serviceAlias: 'api', image: 'a/api:1', ...over });

describe('diffService', () => {
  it('a new service is a create', () => {
    expect(diffService(undefined, app()).action).toBe('create');
  });

  it('says unchanged when nothing that matters differs', () => {
    const a = app({ env: [{ key: 'A', value: '1' }] });
    const d = diffService(a, structuredClone(a));
    expect(d).toMatchObject({ action: 'unchanged', reasons: [] });
  });

  it('names the environment variables that changed, were added or removed, and never a value', () => {
    const before = app({
      env: [
        { key: 'CORS_ORIGIN', value: 'https://old-origin.example' },
        { key: 'GONE', value: 'x' },
      ],
    });
    const after = app({
      env: [
        { key: 'CORS_ORIGIN', value: 'https://new-origin.example' },
        { key: 'INVOICES_BASE_URL', value: 'https://invoices.example' },
      ],
    });
    const d = diffService(before, after);
    expect(d.action).toBe('restart');
    expect(d.reasons).toEqual([
      'environment: CORS_ORIGIN changed, INVOICES_BASE_URL added, GONE removed',
    ]);
    expect(JSON.stringify(d)).not.toMatch(
      /old-origin|new-origin|invoices\.example/,
    );
  });

  it('says an image change with both images, which are not secret', () => {
    const d = diffService(app(), app({ image: 'a/api:2' }));
    expect(d).toMatchObject({
      action: 'restart',
      reasons: ['image a/api:1 → a/api:2'],
      briefOutage: false,
    });
  });

  it('flags a changed secret-looking variable, so a mistyped one is noticed', () => {
    const d = diffService(
      app({
        env: [
          { key: 'JWT_SECRET', value: 'one' },
          { key: 'PORT', value: '1' },
        ],
      }),
      app({
        env: [
          { key: 'JWT_SECRET', value: 'two' },
          { key: 'PORT', value: '2' },
        ],
      }),
    );
    expect(d.secretsChanged).toEqual(['JWT_SECRET']);
  });

  it('a service with a volume has a brief outage when it restarts; the others do not', () => {
    const vol = { containerPath: '/d', volumeName: 'd', readOnly: false };
    const a = app({ persistent: true, volumes: [vol] });
    const d = diffService(a, { ...a, image: 'a/api:2' });
    expect(d).toMatchObject({ action: 'restart', briefOutage: true });
  });

  it('a change of address or instances applies without a restart', () => {
    const d = diffService(
      app(),
      app({ instanceCount: 2, containerPort: 3000 }),
    );
    expect(d.action).toBe('update');
    expect(d.reasons).toEqual([
      'instances 1 → 2',
      'how it is reached from the internet changed',
    ]);
  });
});

describe('diffPlan', () => {
  it('lists every service of the file, then the ones it drops (when removal will happen)', () => {
    const db = makeApp({ name: 'upti-db', serviceAlias: 'db' });
    const web = makeApp({ name: 'upti-web', serviceAlias: 'web' });
    const newer = makeApp({ name: 'upti-inv', serviceAlias: 'inv' });
    const diff = diffPlan([db, web], [db, newer], true);
    expect(diff.map((d) => `${d.service}:${d.action}`)).toEqual([
      'db:unchanged',
      'inv:create',
      'web:remove',
    ]);
    expect(diffPlan([db, web], [db], false).map((d) => d.action)).toEqual([
      'unchanged',
    ]);
  });
});
