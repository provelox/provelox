import { posix } from 'node:path';

/** Server directories that give a container control over the whole host. Mounting one needs an explicit acknowledgement. */
const SENSITIVE = [
  '/',
  '/etc',
  '/root',
  '/proc',
  '/sys',
  '/boot',
  '/dev',
  '/var/run',
  '/run',
  '/var/lib/docker',
  '/var/lib/containerd',
  '/var/lib/kubelet',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/home',
];

// `.` and `..` segments are resolved first, so /./etc and /var/./lib/docker are the directories they name
const clean = (p: string) =>
  posix
    .normalize(p)
    .replace(/\/+/g, '/')
    .replace(/(.)\/$/, '$1');

/** True when the path is, or sits inside, a directory that exposes the host (or is the Docker socket). */
export function isSensitiveHostPath(path: string): boolean {
  const p = clean(path);
  if (p.endsWith('docker.sock')) return true;
  if (p === '/' || p === '/var' || p === '/var/lib') return true;
  return SENSITIVE.some((s) => s !== '/' && (p === s || p.startsWith(`${s}/`)));
}
