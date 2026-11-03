import { buildServiceSpec } from './service-spec';
import { makeApp } from './test-fixtures';

const ctx = {
  rootDomain: 'example.com',
  certResolver: 'le',
  placeholderImage: 'pvx/placeholder:latest',
  placeholder: null as { id: string; name: string } | null,
  errorPagesService: null as string | null,
};

describe('buildServiceSpec', () => {
  it('names and labels the service so ownership is provable', () => {
    const s = buildServiceSpec(makeApp(), ctx);
    expect(s.Name).toBe('pvx-my-app');
    expect(s.Labels['io.provelox.managed']).toBe('true');
    expect(s.Labels['io.provelox.app']).toBe('my-app');
    expect(s.TaskTemplate.ContainerSpec.Labels['io.provelox.managed']).toBe(
      'true',
    );
  });

  it('runs the placeholder until a real image is deployed', () => {
    expect(
      buildServiceSpec(makeApp(), ctx).TaskTemplate.ContainerSpec.Image,
    ).toBe('pvx/placeholder:latest');
    expect(
      buildServiceSpec(makeApp({ image: 'nginx:1' }), ctx).TaskTemplate
        .ContainerSpec.Image,
    ).toBe('nginx:1');
  });

  it('mounts the placeholder page only while no real image is deployed', () => {
    const withPage = {
      ...ctx,
      placeholder: { id: 'c1', name: 'pvx-placeholder-abc' },
    };
    const before = buildServiceSpec(makeApp(), withPage).TaskTemplate
      .ContainerSpec;
    expect(before.Configs).toEqual([
      {
        ConfigID: 'c1',
        ConfigName: 'pvx-placeholder-abc',
        File: {
          Name: '/usr/share/nginx/html/index.html',
          UID: '0',
          GID: '0',
          Mode: 0o444,
        },
      },
    ]);
    const after = buildServiceSpec(makeApp({ image: 'acme/site:1' }), withPage)
      .TaskTemplate.ContainerSpec;
    expect(after.Configs).toBeUndefined();
  });

  it('joins the shared network under the app name', () => {
    const nets = buildServiceSpec(makeApp(), ctx).TaskTemplate.Networks;
    expect(nets).toEqual([{ Target: 'provelox-net', Aliases: ['my-app'] }]);
  });

  it('also answers to its aliases on the shared network', () => {
    const nets = buildServiceSpec(
      makeApp({ aliases: ['srv-captain--my-app'] }),
      ctx,
    ).TaskTemplate.Networks;
    expect(nets).toEqual([
      {
        Target: 'provelox-net',
        Aliases: ['my-app', 'srv-captain--my-app'],
      },
    ]);
  });

  it('turns env, command and entrypoint into container settings', () => {
    const c = buildServiceSpec(
      makeApp({
        env: [{ key: 'A', value: '1' }],
        command: ['serve'],
        entrypoint: ['/bin/sh', '-c'],
      }),
      ctx,
    ).TaskTemplate.ContainerSpec;
    expect(c.Env).toEqual(['A=1']);
    expect(c.Args).toEqual(['serve']);
    expect(c.Command).toEqual(['/bin/sh', '-c']);
  });

  describe('placement in a cluster', () => {
    const where = (app = makeApp(), c: object = {}) =>
      buildServiceSpec(app, { ...ctx, ...c }).TaskTemplate.Placement;

    it('runs anywhere by default', () => {
      expect(where()).toBeUndefined();
    });
    it('can be held to one machine or to a role', () => {
      expect(where(makeApp({ placement: { node: 'dfw-2' } }))).toEqual({
        Constraints: ['node.hostname==dfw-2'],
      });
      expect(where(makeApp({ placement: { role: 'worker' } }))).toEqual({
        Constraints: ['node.role==worker'],
      });
    });
    it('keeps an app with local volumes on the machine that has them, whatever else is set', () => {
      expect(
        where(makeApp({ placement: { role: 'worker' } }), {
          pinnedNode: 'xyz123',
        }),
      ).toEqual({ Constraints: ['node.id==xyz123'] });
    });
  });

  describe('data and instances', () => {
    it('forces one instance and stop-first updates for apps that keep data', () => {
      const s = buildServiceSpec(
        makeApp({ persistent: true, instanceCount: 3 }),
        ctx,
      );
      expect(s.Mode.Replicated.Replicas).toBe(1);
      expect(s.UpdateConfig.Order).toBe('stop-first');
    });
    it('scales stateless apps and starts the new task first', () => {
      const s = buildServiceSpec(makeApp({ instanceCount: 3 }), ctx);
      expect(s.Mode.Replicated.Replicas).toBe(3);
      expect(s.UpdateConfig.Order).toBe('start-first');
    });
    it('mounts managed volumes under a prefixed, labelled Docker name', () => {
      const m = buildServiceSpec(
        makeApp({
          persistent: true,
          volumes: [{ containerPath: '/data', volumeName: 'files' }],
        }),
        ctx,
      ).TaskTemplate.ContainerSpec.Mounts[0];
      expect(m).toMatchObject({
        Type: 'volume',
        Source: 'pvx-my-app-files',
        Target: '/data',
      });
      expect(m.VolumeOptions.Labels['io.provelox.managed']).toBe('true');
    });
    it('mounts a server directory as a bind mount', () => {
      const m = buildServiceSpec(
        makeApp({
          persistent: true,
          volumes: [
            { containerPath: '/in', hostPath: '/srv/in', readOnly: true },
          ],
        }),
        ctx,
      ).TaskTemplate.ContainerSpec.Mounts[0];
      expect(m).toMatchObject({
        Type: 'bind',
        Source: '/srv/in',
        Target: '/in',
        ReadOnly: true,
      });
    });
  });

  it('publishes host ports', () => {
    const s = buildServiceSpec(
      makeApp({ ports: [{ containerPort: 5432, hostPort: 15432 }] }),
      ctx,
    );
    expect(s.EndpointSpec?.Ports).toEqual([
      {
        Protocol: 'tcp',
        TargetPort: 5432,
        PublishedPort: 15432,
        PublishMode: 'ingress',
      },
    ]);
  });

  it('converts healthcheck and resources to Docker units', () => {
    const t = buildServiceSpec(
      makeApp({
        healthcheck: { test: ['CMD', 'true'], intervalSeconds: 5, retries: 3 },
        resources: { cpus: 0.5, memoryBytes: 256 * 1024 * 1024 },
      }),
      ctx,
    ).TaskTemplate;
    expect(t.ContainerSpec.Healthcheck).toEqual({
      Test: ['CMD', 'true'],
      Interval: 5_000_000_000,
      Retries: 3,
    });
    expect(t.Resources.Limits).toEqual({
      NanoCPUs: 500_000_000,
      MemoryBytes: 268435456,
    });
  });

  describe('compose projects', () => {
    const app = makeApp({
      name: 'shop-db',
      project: 'shop',
      serviceAlias: 'db',
      volumes: [{ containerPath: '/v', volumeName: 'pgdata' }],
      persistent: true,
    });
    it('also joins the project network with the compose service name as alias', () => {
      const nets = buildServiceSpec(app, ctx).TaskTemplate.Networks;
      expect(nets).toContainEqual({ Target: 'pvx-net-shop', Aliases: ['db'] });
      expect(nets).toContainEqual({
        Target: 'provelox-net',
        Aliases: ['shop-db'],
      });
    });
    it('names volumes after the project so services can share them', () => {
      expect(
        buildServiceSpec(app, ctx).TaskTemplate.ContainerSpec.Mounts[0].Source,
      ).toBe('pvx-shop-pgdata');
    });
    it('labels the service with its project', () => {
      expect(buildServiceSpec(app, ctx).Labels['io.provelox.project']).toBe(
        'shop',
      );
    });
  });
});
