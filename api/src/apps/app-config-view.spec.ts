import { appDefinition } from './app.model';
import { appConfigView } from './app-config-view';

const HASH = '$2a$08$' + 'a'.repeat(53);

describe('appConfigView', () => {
  const app = appDefinition.parse({
    name: 'shop',
    createdAt: '2026-01-01T00:00:00Z',
    image: 'acme/shop:1',
    env: [
      { key: 'DB_PASSWORD', value: 'hunter2-secret-value' },
      { key: 'API_KEY', value: 'sk_live_abc' },
    ],
    command: ['server', '--password=cmd-secret'],
    entrypoint: ['/bin/start', '--token', 'entry-secret'],
    healthcheck: {
      test: ['CMD', 'curl', '-u', 'admin:hc-secret', 'localhost'],
    },
    volumes: [
      { containerPath: '/data', volumeName: 'data' },
      {
        containerPath: '/mnt/x',
        hostPath: '/srv/private/layout',
        readOnly: true,
      },
    ],
    ports: [{ containerPort: 5432, hostPort: 5432 }],
    basicAuth: { users: [{ name: 'admin', hash: HASH }], openPaths: ['/hook'] },
    resources: { cpus: 0.5, memoryBytes: 268435456 },
    placement: { role: 'worker' },
  });

  it('names what is set and never says its value', () => {
    const v = appConfigView(app);
    expect(v.environment).toEqual(['DB_PASSWORD', 'API_KEY']);
    expect(v.passwordProtection).toEqual({
      users: ['admin'],
      openPaths: ['/hook'],
    });
    expect(v.volumes[0]).toMatchObject({ kind: 'volume', name: 'data' });
    expect(v.placement.role).toBe('worker');
    expect(v.resources).toEqual({ cpus: 0.5, memoryBytes: 268435456 });
    expect(v.hasHealthcheck).toBe(true);
  });

  it('carries no value, hash, command argument or server path', () => {
    const text = JSON.stringify(appConfigView(app));
    for (const secret of [
      'hunter2-secret-value',
      'sk_live_abc',
      'cmd-secret',
      'entry-secret',
      'hc-secret',
      HASH,
      '/srv/private/layout',
    ])
      expect(text).not.toContain(secret);
  });

  it('is plain when nothing is set', () => {
    const v = appConfigView(
      appDefinition.parse({ name: 'bare', createdAt: '2026-01-01T00:00:00Z' }),
    );
    expect(v.passwordProtection).toBeNull();
    expect(v.environment).toEqual([]);
    expect(v.hasHealthcheck).toBe(false);
  });
});
