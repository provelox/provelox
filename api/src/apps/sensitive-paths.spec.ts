import { isSensitiveHostPath } from './sensitive-paths';

describe('isSensitiveHostPath', () => {
  it.each([
    '/',
    '/etc',
    '/etc/ssh',
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/var/lib/docker/volumes',
    '/root',
    '//etc//',
    '/home/me',
    '/opt/docker.sock',
  ])('flags %s', (p) => expect(isSensitiveHostPath(p)).toBe(true));
  it.each([
    '/srv/data',
    '/opt/app',
    '/mnt/disk1',
    '/data',
    '/var/lib/myapp',
    '/etcetera',
  ])('allows %s', (p) => expect(isSensitiveHostPath(p)).toBe(false));
});
