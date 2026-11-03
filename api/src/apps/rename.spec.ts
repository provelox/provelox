import { ConflictError, ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';
import { SecretsService } from './secrets.service';
import {
  mentions,
  referencingKeys,
  replaceHost,
  rewriteEnv,
} from './references';

describe('references', () => {
  it('finds whole host names only', () => {
    for (const v of [
      'website-db',
      'website-db:3306',
      'mysql://u:p@website-db:3306/app',
      'http://website-db/',
      'a=1,website-db',
    ])
      expect(mentions(v, 'website-db')).toBe(true);
    for (const v of [
      'website-db.example.com',
      'my-website-db',
      'website-db-2',
      '/var/website-db',
      'x.website-db',
      'website-dbs',
    ])
      expect(mentions(v, 'website-db')).toBe(false);
  });

  it('rewrites only those, and says which variables', () => {
    const env = [
      { key: 'A', value: 'mysql://u:p@db:3306/db' },
      { key: 'B', value: 'db.example.com' },
      { key: 'C', value: 'db' },
    ];
    expect(referencingKeys(env, 'db')).toEqual(['A', 'C']);
    expect(replaceHost(env[0].value, 'db', 'main-db')).toBe(
      'mysql://u:p@main-db:3306/db',
    );
    expect(rewriteEnv(env, 'db', 'main-db').map((e) => e.value)).toEqual([
      'mysql://u:p@main-db:3306/db',
      'db.example.com',
      'main-db',
    ]);
  });
});

describe('AppsService.rename', () => {
  const setup = async () => {
    const s = makeStack();
    s.apps.renameWaitMs = 20;
    s.apps.renamePollMs = 1;
    await s.apps.create({ name: 'old', persistent: true });
    await s.apps.update('old', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    return s;
  };

  it('replaces the service and moves the record', async () => {
    const { apps, docker, repo } = await setup();
    const { view } = await apps.rename('old', 'new');
    expect(view.app.name).toBe('new');
    expect(docker.services.has('pvx-old')).toBe(false);
    expect(docker.services.has('pvx-new')).toBe(true);
    expect(repo.get('old')).toBeUndefined();
    expect(repo.get('new')).toBeDefined();
    expect(view.hosts).toEqual([{ host: 'new.example.com', ssl: false }]);
  });

  it('keeps the data: the volume keeps its Docker name', async () => {
    const { apps, docker } = await setup();
    await apps.rename('old', 'new');
    const mounts =
      docker.services.get('pvx-new')?.TaskTemplate.ContainerSpec.Mounts;
    expect(mounts?.[0]).toMatchObject({ Source: 'pvx-old-data' });
    expect(docker.volumes.has('pvx-new-data')).toBe(false);
    // and a second rename still points at the same data
    await apps.rename('new', 'newer');
    expect(
      docker.services.get('pvx-newer')?.TaskTemplate.ContainerSpec.Mounts?.[0],
    ).toMatchObject({ Source: 'pvx-old-data' });
  });

  it('moves deploy keys and usage history with it', async () => {
    const { apps, ciKeys, db } = await setup();
    ciKeys.create('old', 'ci');
    db.raw
      .prepare('INSERT INTO usage_samples VALUES (?, ?, ?, ?)')
      .run('old', 1, 0.5, 100);
    await apps.rename('old', 'new');
    expect(ciKeys.list('new')).toHaveLength(1);
    expect(ciKeys.list('old')).toHaveLength(0);
    expect(
      db.raw
        .prepare('SELECT COUNT(*) AS n FROM usage_samples WHERE app = ?')
        .get('new'),
    ).toEqual({ n: 1 });
  });

  it('keeps secrets removable after the rename', async () => {
    const s = await setup();
    const secrets = new SecretsService(s.apps, s.docker);
    await secrets.set('old', 'TOKEN', 'x');
    await s.apps.rename('old', 'new');
    expect(s.docker.secrets.size).toBe(1);
    await secrets.remove('new', 'TOKEN');
    expect(s.docker.secrets.size).toBe(0);
  });

  it('carries the machine pin to the new name', async () => {
    const { apps, settings } = await setup();
    settings.set('volumePins', { 'app:old': { id: 'n1', host: 'h1' } });
    await apps.rename('old', 'new');
    expect(settings.get('volumePins')).toEqual({
      'app:new': { id: 'n1', host: 'h1' },
    });
  });

  it('can keep the old name working as an alias', async () => {
    const { apps } = await setup();
    const { view } = await apps.rename('old', 'new', { keepOldName: true });
    expect(view.app.aliases).toEqual(['old']);
  });

  it('rewrites the apps that name it, and leaves the others alone', async () => {
    const { apps } = await setup();
    await apps.create({ name: 'web' });
    await apps.update('web', {
      env: [
        { key: 'DB_HOST', value: 'old' },
        { key: 'URL', value: 'https://old.example.com' },
      ],
    });
    await apps.create({ name: 'other' });
    expect(apps.referencesTo('old')).toEqual([
      { app: 'web', keys: ['DB_HOST'], editable: true },
    ]);
    const done = await apps.rename('old', 'new', { updateReferences: true });
    expect(done.updated).toEqual(['web']);
    expect(apps.getDefinition('web').env).toEqual([
      { key: 'DB_HOST', value: 'new' },
      { key: 'URL', value: 'https://old.example.com' },
    ]);
  });

  it('leaves other apps alone unless asked', async () => {
    const { apps } = await setup();
    await apps.create({ name: 'web' });
    await apps.update('web', { env: [{ key: 'DB_HOST', value: 'old' }] });
    await apps.rename('old', 'new');
    expect(apps.getDefinition('web').env[0].value).toBe('old');
  });

  it('refuses names that are taken or invalid', async () => {
    const { apps } = await setup();
    await apps.create({ name: 'taken' });
    await expect(apps.rename('old', 'taken')).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(apps.rename('old', 'Bad Name')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(apps.rename('old', 'console')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(apps.rename('old', 'old')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('puts the app back when Docker refuses the new one', async () => {
    const { apps, docker, repo } = await setup();
    const real = docker.applyService.bind(docker);
    docker.applyService = async (spec, ...rest) => {
      if (spec.Name === 'pvx-new') throw new Error('boom');
      return real(spec, ...rest);
    };
    await expect(apps.rename('old', 'new')).rejects.toThrow('boom');
    expect(docker.services.has('pvx-old')).toBe(true);
    expect(repo.get('old')).toBeDefined();
    expect(repo.get('new')).toBeUndefined();
  });
});

describe('a renamed app', () => {
  it('keeps its data volume when volumes are edited by a client that does not know the Docker name', async () => {
    const s = makeStack();
    s.apps.renameWaitMs = 20;
    s.apps.renamePollMs = 1;
    await s.apps.create({ name: 'old', persistent: true });
    await s.apps.update('old', {
      volumes: [{ containerPath: '/data', volumeName: 'data' }],
    });
    await s.apps.rename('old', 'new');
    await s.apps.update('new', {
      volumes: [
        { containerPath: '/data', volumeName: 'data' },
        { containerPath: '/more', volumeName: 'more' },
      ],
    });
    const mounts =
      s.docker.services.get('pvx-new')?.TaskTemplate.ContainerSpec.Mounts;
    expect(mounts?.map((m: { Source?: string }) => m.Source)).toEqual([
      'pvx-old-data',
      'pvx-new-more',
    ]);
  });
});
