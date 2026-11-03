import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RuntimeContext,
  ServiceInfo,
  SourceRuntime,
} from '../../core/source';
import { waitNoContainers } from '../../core/live-containers';
import { caproverService } from './config';

/** CapRover's own services, in the order to stop them: its proxy and helpers first, the dashboard last. */
const PLATFORM = [
  'captain-nginx',
  'captain-certbot',
  'captain-captain',
  'captain-registry',
];

export const isCaproverService = (name: string) =>
  name.startsWith('srv-captain--') || PLATFORM.includes(name);

export function orderServices(services: ServiceInfo[]): ServiceInfo[] {
  const rank = (n: string) =>
    n.startsWith('srv-captain--') ? 0 : PLATFORM.indexOf(n) + 1;
  return services
    .filter((s) => isCaproverService(s.name))
    .sort(
      (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
    );
}

export function caproverRuntime({
  docker,
  backupDir,
}: RuntimeContext): SourceRuntime {
  const waitServiceStopped = (service: string) =>
    waitNoContainers(docker, service, service);

  /** Scales a service to zero and unpublishes its ports, saving its full spec first so it can be put back exactly. */
  const stopService = async (service: string) => {
    if (!isCaproverService(service))
      throw new Error(`${service} is not a CapRover service.`);
    const svc = docker.getService(service);
    let info;
    try {
      info = await svc.inspect();
    } catch (e) {
      // No such service: an app that was never deployed on CapRover, or whose service was removed, has nothing running
      // and nothing to stop. Its data is still copied; there is nothing to put back afterwards.
      if ((e as { statusCode?: number }).statusCode === 404)
        return { restore: async () => undefined };
      throw e;
    }
    const original = info.Spec;
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, `${service}.json`),
      JSON.stringify(original, null, 2),
    );
    await svc.update({
      ...original,
      version: info.Version.Index,
      Mode: { Replicated: { Replicas: 0 } },
      EndpointSpec: { ...original.EndpointSpec, Ports: [] },
    });
    return {
      restore: async () => {
        const now = await svc.inspect();
        await svc.update({ ...original, version: now.Version.Index });
      },
    };
  };

  return {
    stopApp: (app) => stopService(caproverService(app)),
    waitStopped: (app) => waitServiceStopped(caproverService(app)),
    stopProxy: async () => {
      await stopService('captain-nginx');
      await waitServiceStopped('captain-nginx');
    },
    services: async () =>
      orderServices(
        (await docker.listServices()).map((s) => ({
          name: s.Spec?.Name ?? '',
          replicas: s.Spec?.Mode?.Replicated?.Replicas ?? 0,
        })),
      ),
    stopService: async (name) => void (await stopService(name)),
    removeService: async (name) => {
      if (!isCaproverService(name))
        throw new Error(`${name} is not a CapRover service.`);
      await docker.getService(name).remove();
    },
  };
}
