import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { makeStack } from '../test-utils';

const ghcr = { domain: 'ghcr.io', username: 'me', password: 's3cret-token' };

describe('RegistriesService', () => {
  it('stores credentials encrypted and never returns the password', async () => {
    const { registries, db } = makeStack();
    const r = await registries.add(ghcr);
    expect(r).toMatchObject({ domain: 'ghcr.io', username: 'me' });
    expect(JSON.stringify(registries.list())).not.toContain('s3cret-token');
    const raw = JSON.stringify(
      db.raw.prepare('SELECT * FROM registries').all(),
    );
    expect(raw).not.toContain('s3cret-token');
  });

  it('verifies credentials with the registry before saving', async () => {
    const { registries, docker } = makeStack();
    docker.rejectRegistry.add('ghcr.io');
    await expect(registries.add(ghcr)).rejects.toBeInstanceOf(ValidationError);
    expect(registries.list()).toEqual([]);
  });

  it('normalises the address and rejects duplicates', async () => {
    const { registries } = makeStack();
    await registries.add({ ...ghcr, domain: 'https://GHCR.io/' });
    await expect(registries.add(ghcr)).rejects.toBeInstanceOf(ConflictError);
  });

  it('validates input', async () => {
    const { registries } = makeStack();
    await expect(
      registries.add({ domain: '', username: 'a', password: 'b' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      registries.add({ domain: 'x.io', username: '', password: 'b' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      registries.add({ domain: 'x.io', username: 'a' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  describe('upsert', () => {
    it('adds a registry that is not there, and replaces the sign-in of one that is', async () => {
      const { registries } = makeStack();
      const first = await registries.upsert(ghcr);
      expect(registries.list()).toHaveLength(1);
      const again = await registries.upsert({
        ...ghcr,
        domain: 'https://GHCR.io/',
        username: 'other',
        password: 'new-token',
      });
      expect(again.id).toBe(first.id);
      expect(registries.list()).toEqual([
        expect.objectContaining({ domain: 'ghcr.io', username: 'other' }),
      ]);
      expect(registries.authFor('ghcr.io/x/y:1')?.password).toBe('new-token');
    });

    it('still asks the registry, and leaves what was there when it refuses', async () => {
      const { registries, docker } = makeStack();
      await registries.upsert(ghcr);
      docker.rejectRegistry.add('ghcr.io');
      await expect(
        registries.upsert({ ...ghcr, password: 'bad' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(registries.authFor('ghcr.io/x/y:1')?.password).toBe(
        's3cret-token',
      );
    });
  });

  describe('authFor', () => {
    it('matches the registry in the image name', async () => {
      const { registries } = makeStack();
      await registries.add(ghcr);
      expect(registries.authFor('ghcr.io/acme/app:1')).toEqual({
        username: 'me',
        password: 's3cret-token',
        serveraddress: 'ghcr.io',
      });
      expect(registries.authFor('registry.other.com/app')).toBeUndefined();
      expect(registries.authFor('nginx')).toBeUndefined();
      expect(registries.authFor('')).toBeUndefined();
    });
    it('uses the Docker Hub API address for Hub images', async () => {
      const { registries } = makeStack();
      await registries.add({
        domain: 'index.docker.io',
        username: 'me',
        password: 'pw',
      });
      expect(registries.authFor('acme/app:1')?.serveraddress).toBe(
        'https://index.docker.io/v1/',
      );
      expect(registries.authFor('nginx')?.username).toBe('me');
    });
    it('pulls anonymously rather than crashing when the stored password cannot be read', async () => {
      const a = makeStack();
      await a.registries.add(ghcr);
      // same database, but a different server secret
      const { RegistriesService } = await import('./registries.service');
      const other = new RegistriesService(a.db, a.docker, {
        ...a.cfg,
        JWT_SECRET: 'z'.repeat(40),
      });
      expect(other.authFor('ghcr.io/x/y')).toBeUndefined();
    });
  });

  it('passes credentials to Docker when an app on that registry is applied', async () => {
    const { registries, apps, docker } = makeStack();
    await registries.add(ghcr);
    await apps.create({ name: 'site' });
    expect(docker.appliedAuth.get('pvx-site')).toBeUndefined(); // placeholder image is public
    await apps.deploy('site', 'ghcr.io/acme/site:1');
    expect(docker.appliedAuth.get('pvx-site')).toMatchObject({
      username: 'me',
      serveraddress: 'ghcr.io',
    });
    await apps.deploy('site', 'nginx:alpine');
    expect(docker.appliedAuth.get('pvx-site')).toBeUndefined();
  });

  describe('update and remove', () => {
    it('changes the username or password after re-verifying', async () => {
      const { registries, docker } = makeStack();
      const r = await registries.add(ghcr);
      expect(
        (await registries.update(r.id, { username: 'other' })).username,
      ).toBe('other');
      expect(registries.authFor('ghcr.io/a/b')?.password).toBe('s3cret-token');
      await registries.update(r.id, { password: 'new-token' });
      expect(registries.authFor('ghcr.io/a/b')?.password).toBe('new-token');
      docker.rejectRegistry.add('ghcr.io');
      await expect(
        registries.update(r.id, { password: 'bad' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(registries.authFor('ghcr.io/a/b')?.password).toBe('new-token');
    });
    it('cannot change the address', async () => {
      const { registries } = makeStack();
      const r = await registries.add(ghcr);
      await expect(
        registries.update(r.id, { domain: 'evil.io' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
    it('removes and 404s', async () => {
      const { registries } = makeStack();
      const r = await registries.add(ghcr);
      registries.remove(r.id);
      expect(registries.list()).toEqual([]);
      expect(() => registries.remove(r.id)).toThrow(NotFoundError);
      await expect(registries.update(r.id, {})).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('the sign-in the install was given', () => {
    const seedFile = (content: string) => {
      const { mkdtempSync, writeFileSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      const file = join(
        mkdtempSync(join(tmpdir(), 'pvx-seed-')),
        'pvx-registry',
      );
      writeFileSync(file, content);
      return file;
    };
    afterEach(() => delete process.env.REGISTRY_SEED_FILE);

    it('is added on start when that registry has no entry, and used for pulls', () => {
      const { registries } = makeStack();
      process.env.REGISTRY_SEED_FILE = seedFile(
        JSON.stringify({ domain: 'ghcr.io', username: 'me', password: 'tok' }),
      );
      registries.onModuleInit();
      expect(registries.list()).toMatchObject([
        { domain: 'ghcr.io', username: 'me' },
      ]);
      expect(
        registries.authFor('ghcr.io/provelox/provelox:0.2.11'),
      ).toMatchObject({
        username: 'me',
        password: 'tok',
      });
    });

    it('never overwrites an entry someone made in the console, and is harmless to repeat', async () => {
      const { registries } = makeStack();
      await registries.add({
        domain: 'ghcr.io',
        username: 'console-user',
        password: 'console-token',
      });
      process.env.REGISTRY_SEED_FILE = seedFile(
        JSON.stringify({ domain: 'ghcr.io', username: 'me', password: 'tok' }),
      );
      registries.onModuleInit();
      registries.onModuleInit();
      expect(registries.list()).toHaveLength(1);
      expect(registries.list()[0].username).toBe('console-user');
    });

    it('does nothing without a file, and survives a damaged one', () => {
      const { registries } = makeStack();
      registries.onModuleInit();
      process.env.REGISTRY_SEED_FILE = seedFile('not json');
      expect(() => registries.onModuleInit()).not.toThrow();
      process.env.REGISTRY_SEED_FILE = '/nonexistent/file';
      expect(() => registries.onModuleInit()).not.toThrow();
      expect(registries.list()).toEqual([]);
    });
  });

  describe('check', () => {
    it('says which sign-in was used and that the registry let the image through', async () => {
      const { registries } = makeStack();
      await registries.add(ghcr);
      await expect(
        registries.check({ image: 'ghcr.io/provelox/provelox:0.2.13' }),
      ).resolves.toEqual({
        registry: 'ghcr.io',
        user: 'me',
        pull: { ok: true },
      });
    });

    it("gives the registry's reason when it refuses, and says no sign-in was used when there is none", async () => {
      const { registries, docker } = makeStack();
      docker.pullable = (_i, auth) => (auth ? 'unauthorized' : 'denied');
      await registries.add(ghcr);
      await expect(
        registries.check({ image: 'ghcr.io/provelox/provelox:1' }),
      ).resolves.toMatchObject({
        user: 'me',
        pull: { ok: false, reason: 'unauthorized' },
      });
      await expect(
        registries.check({ image: 'registry.example.com/x:1' }),
      ).resolves.toMatchObject({
        user: null,
        pull: { ok: false, reason: 'denied' },
      });
    });

    it('only takes an image name', async () => {
      const { registries } = makeStack();
      for (const image of ['', '  ', 'a b', 'x?y=1', '../etc', 'x'.repeat(301)])
        await expect(registries.check({ image })).rejects.toBeInstanceOf(
          ValidationError,
        );
      await expect(registries.check({})).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });
});
