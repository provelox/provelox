import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { SecretsService } from './secrets.service';
import { makeStack } from '../test-utils';

async function setup() {
  const s = makeStack();
  await s.apps.create({ name: 'site' });
  return { ...s, secrets: new SecretsService(s.apps, s.docker) };
}

describe('SecretsService', () => {
  it('stores the value in Docker only, mounted as a file under the secret name', async () => {
    const { secrets, docker, repo } = await setup();
    const list = await secrets.set('site', 'DB_PASSWORD', 'hunter2');
    expect(list.map((s) => s.name)).toEqual(['DB_PASSWORD']);
    const [dockerName] = [...docker.secrets.keys()];
    expect(dockerName).toMatch(/^pvx-site-DB_PASSWORD-[0-9a-f]{10}$/);
    expect(docker.secrets.get(dockerName)?.value).toBe('hunter2');
    expect(docker.secrets.get(dockerName)?.labels['io.provelox.app']).toBe(
      'site',
    );
    const mount =
      docker.services.get('pvx-site')?.TaskTemplate.ContainerSpec.Secrets?.[0];
    expect(mount).toMatchObject({
      SecretName: dockerName,
      File: { Name: 'DB_PASSWORD' },
    });
    // the value is nowhere in what this service keeps
    expect(JSON.stringify(repo.get('site'))).not.toContain('hunter2');
    expect(JSON.stringify(list)).not.toContain('hunter2');
  });

  it('replaces a value with a new Docker secret and removes the old one', async () => {
    const { secrets, docker } = await setup();
    await secrets.set('site', 'TOKEN', 'one');
    const first = [...docker.secrets.keys()][0];
    await secrets.set('site', 'TOKEN', 'two');
    const names = [...docker.secrets.keys()];
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(first);
    expect(docker.secrets.get(names[0])?.value).toBe('two');
  });

  it('removes a secret everywhere', async () => {
    const { secrets, docker, apps } = await setup();
    await secrets.set('site', 'TOKEN', 'x');
    expect(await secrets.remove('site', 'TOKEN')).toEqual([]);
    expect(docker.secrets.size).toBe(0);
    expect(
      docker.services.get('pvx-site')?.TaskTemplate.ContainerSpec.Secrets,
    ).toBeUndefined();
    expect(apps.getDefinition('site').secrets).toEqual([]);
  });

  it('rolls back the new Docker secret when the service update fails', async () => {
    const { secrets, docker, apps } = await setup();
    await secrets.set('site', 'TOKEN', 'old');
    docker.failNextApply = new Error('docker said no');
    await expect(secrets.set('site', 'TOKEN', 'new')).rejects.toThrow(
      'docker said no',
    );
    expect(docker.secrets.size).toBe(1);
    expect([...docker.secrets.values()][0].value).toBe('old');
    expect(apps.getDefinition('site').secrets).toHaveLength(1);
  });

  it('validates names, values and limits', async () => {
    const { secrets } = await setup();
    await expect(secrets.set('site', '../etc', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(secrets.set('site', 'A', '')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      secrets.set('site', 'A', 'x'.repeat(501 * 1024)),
    ).rejects.toBeInstanceOf(ValidationError);
    for (let i = 0; i < 50; i++) await secrets.set('site', `S${i}`, 'v');
    await expect(
      secrets.set('site', 'ONE_TOO_MANY', 'v'),
    ).rejects.toBeInstanceOf(ConflictError);
    // replacing one at the limit is fine
    await expect(secrets.set('site', 'S1', 'new')).resolves.toBeDefined();
  });

  it('404s for a missing secret or app', async () => {
    const { secrets } = await setup();
    await expect(secrets.remove('site', 'NOPE')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(secrets.set('ghost', 'A', 'v')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('never deletes a secret that belongs to another app', async () => {
    const { docker } = await setup();
    docker.secrets.set('pvx-other-X-1', {
      value: 'v',
      labels: { 'io.provelox.managed': 'true', 'io.provelox.app': 'other' },
    });
    await expect(
      docker.removeSecret('pvx-other-X-1', 'site'),
    ).rejects.toThrow();
    expect(docker.secrets.has('pvx-other-X-1')).toBe(true);
  });

  it('deleting the app deletes its Docker secrets too, and only its own', async () => {
    const { secrets, docker, apps } = await setup();
    await secrets.set('site', 'TOKEN', 'x');
    await secrets.set('site', 'OTHER', 'y');
    docker.secrets.set('pvx-keep-ME-1', {
      value: 'z',
      labels: { 'io.provelox.managed': 'true', 'io.provelox.app': 'keep' },
    });
    expect(docker.secrets.size).toBe(3);
    await apps.remove('site');
    expect([...docker.secrets.keys()]).toEqual(['pvx-keep-ME-1']);
  });

  it('a secret that cannot be removed does not undo the removal of the app', async () => {
    const { secrets, docker, apps } = await setup();
    await secrets.set('site', 'TOKEN', 'x');
    docker.removeSecret = async () => {
      throw new Error('docker said no');
    };
    await expect(apps.remove('site')).resolves.toBeDefined();
    expect(docker.services.has('pvx-site')).toBe(false);
  });
});

describe('SecretsService: secrets lost from Docker (a rebuilt Swarm)', () => {
  /** An app with two secrets whose Docker secrets then vanish */
  async function lost() {
    const s = await setup();
    await s.secrets.set('site', 'A_KEY', 'a');
    await s.secrets.set('site', 'B_KEY', 'b');
    s.docker.secrets.clear();
    s.docker.services.clear();
    return s;
  }

  it('reports which secrets are missing, in the app view and the list', async () => {
    const { apps } = await lost();
    expect((await apps.get('site')).missingSecrets.sort()).toEqual([
      'A_KEY',
      'B_KEY',
    ]);
    expect((await apps.list())[0].missingSecrets.sort()).toEqual([
      'A_KEY',
      'B_KEY',
    ]);
  });

  it('reports nothing for an app whose secrets are all present', async () => {
    const { apps, secrets } = await setup();
    await secrets.set('site', 'A_KEY', 'a');
    expect((await apps.get('site')).missingSecrets).toEqual([]);
  });

  it('refuses other changes with a message that says what to do, not a Docker error', async () => {
    const { apps } = await lost();
    await expect(apps.update('site', { containerPort: 8080 })).rejects.toThrow(
      /secrets A_KEY, B_KEY no longer exist.*Secrets tab/s,
    );
    await expect(
      apps.update('site', { containerPort: 8080 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets them be set again one at a time, starting the app only after the last', async () => {
    const { apps, secrets, docker } = await lost();
    await secrets.set('site', 'A_KEY', 'a2');
    expect((await apps.get('site')).missingSecrets).toEqual(['B_KEY']);
    expect(docker.services.has('pvx-site')).toBe(false);
    await secrets.set('site', 'B_KEY', 'b2');
    expect((await apps.get('site')).missingSecrets).toEqual([]);
    expect(docker.services.has('pvx-site')).toBe(true);
  });

  it('lets a lost secret be deleted instead, and starts the app once none are missing', async () => {
    const { apps, secrets, docker } = await lost();
    await secrets.remove('site', 'A_KEY');
    expect(docker.services.has('pvx-site')).toBe(false);
    await secrets.remove('site', 'B_KEY');
    expect((await apps.get('site')).missingSecrets).toEqual([]);
    expect(docker.services.has('pvx-site')).toBe(true);
  });

  it('does not block anything when Docker cannot list its secrets', async () => {
    const { apps, docker } = await lost();
    docker.secretIds = async () => {
      throw new Error('docker hiccup');
    };
    expect((await apps.get('site')).missingSecrets).toEqual([]);
  });
});
