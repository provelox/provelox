import { describe, expect, it } from 'vitest';
import { proposeTidyNames } from '@/lib/tidy-names';

const ROOT = 'apps.example.com';
const app = (name: string, hosts: string[], project?: string) => ({
  name,
  hosts: [`${name}.${ROOT}`, ...hosts],
  project,
});
const run = (apps: ReturnType<typeof app>[], collections = [] as never[]) =>
  proposeTidyNames({ apps, rootDomain: ROOT, collections });

describe('proposeTidyNames', () => {
  it('names an app for the domain it answers on', () => {
    const { proposals } = run([
      app('site', ['loxti.com']),
      app('backend', ['api.loxti.com']),
      app('console', ['admin.fleetstry.com']),
    ]);
    expect(proposals.map((p) => [p.app, p.to])).toEqual([
      ['console', 'fleetstry-admin'],
      ['backend', 'loxti-api'],
      ['site', 'loxti-web'],
    ]);
    expect(proposals[1]).toMatchObject({
      host: 'api.loxti.com',
      product: 'loxti',
      role: 'api',
    });
  });

  it('reads the first custom domain, not the default address', () => {
    const { proposals } = run([app('x', ['api.loxti.com', 'www.loxti.com'])]);
    expect(proposals[0].to).toBe('loxti-api');
  });

  it('tries the next domain when the first gives no name', () => {
    const { proposals } = run([
      app('x', [`${'a'.repeat(40)}.${'b'.repeat(40)}.com`, 'api.loxti.com']),
    ]);
    expect(proposals[0]?.to).toBe('loxti-api');
  });

  it('leaves out apps with no custom domain, in a project, or already named so, with why', () => {
    const { proposals, skipped } = run([
      app('plain', []),
      app('wp-db', ['db.loxti.com'], 'wordpress'),
      app('loxti-api', ['api.loxti.com']),
    ]);
    expect(proposals).toEqual([]);
    expect(skipped).toEqual([
      { app: 'plain', reason: 'No custom domain' },
      { app: 'wp-db', reason: 'Part of a project' },
    ]);
  });

  it('leaves out a name an existing app already has', () => {
    const { proposals, skipped } = run([
      app('loxti-api', []),
      app('backend', ['api.loxti.com']),
    ]);
    expect(proposals).toEqual([]);
    expect(skipped[skipped.length - 1].reason).toMatch(/already an app/);
  });

  it('leaves out both when two apps would get the same name', () => {
    const { proposals, skipped } = run([
      app('a', ['api.loxti.com']),
      app('b', ['api.loxti.co.uk']),
    ]);
    expect(proposals).toEqual([]);
    expect(skipped.map((s) => s.app)).toEqual(['a', 'b']);
  });

  it('suggests the collection only when exactly one fits and the app is not in it', () => {
    const cols = [
      { id: 'g_1', name: 'Loxti', appNames: ['inside'] },
      { id: 'g_2', name: 'Fleetstry Production', appNames: [] },
      { id: 'g_3', name: 'Fleetstry Staging', appNames: [] },
    ];
    const { proposals } = proposeTidyNames({
      apps: [
        app('inside', ['api.loxti.com']),
        app('outside', ['app.loxti.com']),
        app('f', ['admin.fleetstry.com']),
      ],
      rootDomain: ROOT,
      collections: cols,
    });
    const by = Object.fromEntries(proposals.map((p) => [p.app, p.collection]));
    expect(by.inside).toBeNull(); // already there
    expect(by.outside).toEqual({ id: 'g_1', name: 'Loxti' });
    expect(by.f).toBeNull(); // two fit: a guess
  });
});
