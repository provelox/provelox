import { ConflictError, ValidationError } from '../common/errors';
import type { RegistryAuth } from '../docker/docker.port';
import { FakeDocker } from '../docker/fake-docker';
import { buildApiSpec } from './api-spec';
import { buildConsoleSpec } from './console-spec';
import { compareVersions, retag, SelfUpdateService } from './self-update';

describe('retag', () => {
  it('replaces the tag', () =>
    expect(retag('reg.io/org/img:0.2.6', '0.2.7')).toBe(
      'reg.io/org/img:0.2.7',
    ));
  it('adds a tag to a bare name', () =>
    expect(retag('org/img', '0.2.7')).toBe('org/img:0.2.7'));
  it('does not mistake a registry port for a tag', () =>
    expect(retag('localhost:5000/img', '0.2.7')).toBe(
      'localhost:5000/img:0.2.7',
    ));
  it('drops a digest', () =>
    expect(retag('reg.io/img:0.2.6@sha256:abc', '0.2.7')).toBe(
      'reg.io/img:0.2.7',
    ));
});

describe('compareVersions', () => {
  it('orders releases by number, not text', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.9', '0.2.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.7', '0.2.7')).toBe(0);
  });
  it('puts a pre-release before its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    // pre-release numbers are numbers: rc.10 is after rc.8 (it used to be read as older)
    expect(compareVersions('0.5.0-rc.10', '0.5.0-rc.8')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0-rc.8', '0.5.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-rc.1')).toBeLessThan(0);
  });
});

describe('SelfUpdateService', () => {
  const setup = async (withConsole = true) => {
    const docker = new FakeDocker();
    const secret = { id: 's', name: 'n' };
    await docker.applyService(
      buildApiSpec({
        image: 'reg.io/img:0.2.6',
        port: 4000,
        httpPort: 80,
        httpsPort: 443,
        certResolver: 'le',
        jwtSecret: secret,
      }),
      'provelox',
    );
    if (withConsole)
      await docker.applyService(
        buildConsoleSpec({
          image: 'reg.io/img:0.2.6',
          host: { host: 'console.example.com', ssl: false },
          certResolver: 'le',
          apiUrl: 'http://provelox:4000',
          sessionSecret: secret,
        }),
        'console',
      );
    const registries = {
      stored: undefined as RegistryAuth | undefined,
      authFor(_image: string) {
        return registries.stored;
      },
    };
    return {
      docker,
      registries,
      svc: new SelfUpdateService(docker, registries as never),
    };
  };

  it('moves the API and the console to the new tag', async () => {
    const { docker, svc } = await setup();
    const r = await svc.update('v0.2.7');
    expect(r.to).toBe('reg.io/img:0.2.7');
    expect((await docker.serviceStatus('pvx-provelox'))?.image).toBe(
      'reg.io/img:0.2.7',
    );
    expect((await docker.serviceStatus('pvx-console'))?.image).toBe(
      'reg.io/img:0.2.7',
    );
  });

  it('only goes forward: an older release is a reinstall, not an update', async () => {
    const { docker, svc } = await setup();
    await expect(svc.update('0.2.5')).rejects.toThrow(/older than the 0.2.6/);
    expect((await docker.serviceStatus('pvx-provelox'))?.image).toBe(
      'reg.io/img:0.2.6',
    );
    await expect(svc.update('0.2.6')).rejects.toThrow(/Already running/);
    await expect(svc.update('0.10.0')).resolves.toMatchObject({
      to: 'reg.io/img:0.10.0',
    });
  });

  it('works without a console', async () => {
    const { svc } = await setup(false);
    await expect(svc.update('0.2.7')).resolves.toMatchObject({
      to: 'reg.io/img:0.2.7',
    });
  });

  it('refuses moving tags and malformed versions', async () => {
    const { svc } = await setup();
    for (const v of ['latest', 'edge', '', '0.2', '1.0.0; rm', '../x'])
      await expect(svc.update(v)).rejects.toBeInstanceOf(ValidationError);
  });

  it('says so when it already runs that release', async () => {
    const { svc } = await setup();
    await expect(svc.update('0.2.6')).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses while another update is running', async () => {
    const { docker, svc } = await setup();
    docker.statusOverride = () => ({
      desired: 1,
      running: 1,
      state: 'running' as const,
      image: 'reg.io/img:0.2.6',
      updateState: 'updating',
    });
    await expect(svc.update('0.2.7')).rejects.toBeInstanceOf(ConflictError);
  });

  it('asks the registry first and changes nothing when the image cannot be pulled', async () => {
    const { docker, svc } = await setup();
    docker.pullable = () => 'no basic auth credentials';
    const calls = docker.calls.length;
    await expect(svc.update('0.2.7')).rejects.toThrow(
      /cannot pull reg\.io\/img:0\.2\.7 \(no sign-in is stored for reg\.io\): no basic auth credentials.*Settings → Registries/,
    );
    expect(docker.calls.slice(calls)).toEqual([]);
    expect((await docker.serviceStatus('pvx-provelox'))?.image).toBe(
      'reg.io/img:0.2.6',
    );
  });

  it('uses the stored sign-in for the registry, to check and to update both services', async () => {
    const { docker, registries, svc } = await setup();
    const auth = {
      username: 'u',
      password: 'p',
      serveraddress: 'reg.example.com',
    };
    registries.stored = auth;
    docker.pullable = (_image, a) => (a?.password === 'p' ? null : 'denied');
    await svc.update('0.2.7');
    expect(docker.editAuth.get('pvx-provelox')).toEqual(auth);
    expect(docker.editAuth.get('pvx-console')).toEqual(auth);
  });

  it('adds no sign-in when none is stored, so Docker keeps the service’s own', async () => {
    const { docker, svc } = await setup();
    await svc.update('0.2.7');
    expect(docker.editAuth.get('pvx-provelox')).toBeUndefined();
  });

  it('says when the stored sign-in was tried and refused, which is not the same as having none', async () => {
    const { docker, registries, svc } = await setup();
    registries.stored = {
      username: 'ynunez',
      password: 'p',
      serveraddress: 'reg.io',
    };
    docker.pullable = () => 'unauthorized';
    await expect(svc.update('0.2.7')).rejects.toThrow(
      /even with the stored sign-in for reg\.io \(user ynunez\): unauthorized\. The registry accepted that account but not for this image: check that the token can read packages/,
    );
    expect(docker.editAuth.size).toBe(0);
  });
});
