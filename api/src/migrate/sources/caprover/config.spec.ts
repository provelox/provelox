import { classify } from '../../core/inventory';
import { caproverApps, type CaproverConfig } from './config';

const config: CaproverConfig = {
  appDefinitions: {
    web: {
      instanceCount: 2,
      containerHttpPort: 3000,
      envVars: [
        { key: 'SELF', value: 'srv-captain--$$cap_appname' },
        { key: 'HOST', value: 'x.$$cap_root_domain' },
        { key: 'ODD', value: '$$cap_gitHash' },
      ],
      customDomain: [{ publicDomain: 'web.example.com', hasSsl: true }],
      versions: [{ version: 1, deployedImageName: 'nginx:1' }],
      deployedVersion: 1,
    },
    db: {
      hasPersistentData: true,
      volumes: [{ containerPath: '/data', volumeName: 'db-data' }],
      versions: [{ version: 0, deployedImageName: 'postgres:16' }],
      deployedVersion: 0,
    },
    site: {
      customDomain: [
        { publicDomain: 'www.site.org' },
        { publicDomain: 'site.org' },
      ],
      redirectDomain: 'www.site.org',
      versions: [{ version: 0, deployedImageName: 'nginx:1' }],
      deployedVersion: 0,
    },
    lost: {
      customDomain: [{ publicDomain: 'a.org' }],
      redirectDomain: 'elsewhere.org',
      versions: [{ version: 0, deployedImageName: 'nginx:1' }],
      deployedVersion: 0,
    },
    dns: {
      hasPersistentData: true,
      volumes: [{ containerPath: '/c', volumeName: 'dns-c' }],
      ports: [
        { hostPort: 53, containerPort: 53 },
        { hostPort: 69, containerPort: 69, protocol: 'udp' },
      ],
      versions: [{ version: 1, deployedImageName: 'adguard/adguardhome:1' }],
      deployedVersion: 1,
    },
    custom: {
      customNginxConfig: 'location / {}',
      versions: [{ version: 1, deployedImageName: 'img-captain--custom:1' }],
      deployedVersion: 1,
    },
    fresh: {
      versions: [
        {
          version: 0,
          deployedImageName: 'caprover/caprover-placeholder-app:latest',
        },
      ],
      deployedVersion: 0,
    },
    Bad_Name: {
      versions: [{ version: 1, deployedImageName: 'x:1' }],
      deployedVersion: 1,
    },
    binds: {
      volumes: [{ containerPath: '/x', hostPath: '/srv/x' }],
      versions: [{ version: 1, deployedImageName: 'x:1' }],
      deployedVersion: 1,
    },
  },
};

describe('CapRover source', () => {
  const apps = caproverApps(config, { rootDomain: 'cap.test' });
  const by = (n: string) => apps.find((a) => a.name === n)!;

  it('maps names, volumes and the alias CapRover uses on its network', () => {
    expect(by('db').volumes).toEqual([
      { containerPath: '/data', volume: 'captain--db-data', name: 'db-data' },
    ]);
    expect(by('web').alias).toBe('srv-captain--web');
    expect(by('db').persistent).toBe(true);
  });

  it('publishes both protocols for a port that names none, as CapRover does', () => {
    expect(by('dns').hostPorts).toEqual([
      { hostPort: 53, containerPort: 53, protocol: 'tcp' },
      { hostPort: 53, containerPort: 53, protocol: 'udp' },
      { hostPort: 69, containerPort: 69, protocol: 'udp' },
    ]);
  });

  it('resolves the placeholders it knows and warns about the rest', () => {
    const env = Object.fromEntries(by('web').env.map((e) => [e.key, e.value]));
    expect(env.SELF).toBe('srv-captain--web');
    expect(env.HOST).toBe('x.cap.test');
    expect(env.ODD).toBe('$$cap_gitHash');
    expect(by('web').warnings.join(' ')).toMatch(/\$\$cap_gitHash/);
  });

  it('blocks what cannot move and flags what needs a look', () => {
    expect(by('custom').blocker).toMatch(/registry/);
    expect(by('Bad_Name').blocker).toMatch(/Name/);
    expect(by('binds').blocker).toMatch(/directory/);
    expect(by('custom').attention.join(' ')).toMatch(/nginx/);
    expect(classify(by('web'))).toBe('ready');
  });

  it('carries the redirect domain over as the primary address', () => {
    expect(by('site').primaryDomain).toBe('www.site.org');
    expect(by('site').attention.join(' ')).not.toMatch(/Redirects/);
  });

  it('asks for a hand-set primary address when the redirect target is not one of its domains', () => {
    expect(by('lost').primaryDomain).toBeUndefined();
    expect(by('lost').attention.join(' ')).toMatch(/elsewhere\.org/);
  });

  it('treats the placeholder page as no image', () => {
    expect(by('fresh').image).toBe('');
    expect(by('fresh').notes.join(' ')).toMatch(/placeholder/);
  });
});

describe('HTTP basic auth from CapRover', () => {
  const hash = '$2a$10$' + 'c'.repeat(53);
  const read = (httpAuth: object) =>
    caproverApps({
      appDefinitions: {
        admin: {
          httpAuth,
          versions: [{ version: 0, deployedImageName: 'nginx:1' }],
          deployedVersion: 0,
        },
      },
    })[0];

  it('carries over a hash the proxy can read, or a password that can be hashed', () => {
    expect(read({ user: 'secure', passwordHashed: hash }).httpAuth).toEqual({
      user: 'secure',
      hash,
    });
    expect(
      read({ user: 'secure', password: 'a long password' }).httpAuth,
    ).toEqual({
      user: 'secure',
      password: 'a long password',
    });
  });

  it('says so when the password cannot be read, and asks for attention', () => {
    const a = read({ user: 'secure', passwordHashed: 'not-a-known-format' });
    expect(a.httpAuth).toEqual({ user: 'secure' });
    expect(a.attention.join(' ')).toMatch(/basic auth.*cannot be read/);
  });

  it('has none when the app had none', () => {
    expect(read({}).httpAuth).toBeUndefined();
  });
});
