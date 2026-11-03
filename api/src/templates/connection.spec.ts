import {
  connectionOf,
  resolveVariables,
  templateOfProject,
  type DeployedApp,
} from './connection';
import { templateById } from './catalog';

const redis = templateById('redis')!;
const postgres = templateById('postgres')!;
const mongo = templateById('mongodb')!;

describe('templateOfProject', () => {
  it('recognises a project whose compose is still the template’s', () => {
    expect(templateOfProject(redis.compose)?.id).toBe('redis');
    expect(templateOfProject(`${redis.compose}\n`)?.id).toBe('redis');
  });
  it('does not guess when it was edited or is someone else’s', () => {
    expect(
      templateOfProject(redis.compose.replace('redis:7', 'redis:6')),
    ).toBeNull();
    expect(templateOfProject('services:\n  a:\n    image: x\n')).toBeNull();
  });
});

describe('resolveVariables', () => {
  it('reads a variable back from the environment variable it was given to, whatever that is called', () => {
    const apps: DeployedApp[] = [
      {
        name: 'db-mongo',
        env: [
          { key: 'MONGO_INITDB_ROOT_USERNAME', value: 'admin' },
          { key: 'MONGO_INITDB_ROOT_PASSWORD', value: 's3cret' },
        ],
      },
    ];
    const v = resolveVariables(mongo, 'db', apps);
    expect(v.find((x) => x.key === 'MONGO_USER')).toMatchObject({
      value: 'admin',
      where: 'the environment variable MONGO_INITDB_ROOT_USERNAME',
    });
    expect(v.find((x) => x.key === 'MONGO_PASSWORD')?.value).toBe('s3cret');
  });

  it('reads a variable that was given to the command from the same place in the command it runs', () => {
    const apps: DeployedApp[] = [
      {
        name: 'cache-redis',
        env: [],
        command: [
          'redis-server',
          '--requirepass',
          'pw-123',
          '--appendonly',
          'yes',
        ],
      },
    ];
    expect(resolveVariables(redis, 'cache', apps)[0]).toMatchObject({
      key: 'REDIS_PASSWORD',
      value: 'pw-123',
      where: 'its command',
    });
  });

  it('says it cannot find a value rather than guessing', () => {
    expect(resolveVariables(redis, 'cache', [])[0].value).toBeNull();
    expect(
      resolveVariables(redis, 'cache', [
        { name: 'cache-redis', env: [], command: ['redis-server'] },
      ])[0].value,
    ).toBeNull();
  });
});

describe('connectionOf', () => {
  const apps: DeployedApp[] = [
    {
      name: 'pg-postgres',
      env: [
        { key: 'POSTGRES_USER', value: 'app' },
        { key: 'POSTGRES_PASSWORD', value: 'p@ss/word' },
        { key: 'POSTGRES_DB', value: 'shop' },
      ],
    },
  ];

  it('gives the host other apps use, the one inside the project, the port and a ready connection string', () => {
    const c = connectionOf(
      postgres,
      'pg',
      resolveVariables(postgres, 'pg', apps),
    );
    expect(c.host).toBe('pg-postgres');
    expect(c.hostInProject).toBe('postgres');
    expect(c.port).toBe(5432);
    // the password holds characters that must be encoded to sit inside a URL
    expect(c.url).toBe('postgresql://app:p%40ss%2Fword@pg-postgres:5432/shop');
  });

  it('shows what is still needed when a value is unknown, and gives no usable URL', () => {
    const c = connectionOf(
      postgres,
      'pg',
      resolveVariables(postgres, 'pg', []),
    );
    expect(c.url).toBeNull();
    expect(c.urlTemplate).toBe(
      'postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@pg-postgres:5432/<POSTGRES_DB>',
    );
  });

  it('has no connection string for a template that is a web page', () => {
    const web = templateById('adminer')!;
    expect(connectionOf(web, 'db-ui', []).url).toBeNull();
    expect(connectionOf(web, 'db-ui', []).urlTemplate).toBeNull();
  });
});
