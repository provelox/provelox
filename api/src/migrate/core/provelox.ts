import Docker from 'dockerode';
import type { Config } from '../../config/config';
import { DockerodeAdapter } from '../../docker/dockerode.adapter';
import { serviceName } from '../../common/naming';
import type { CutoverDeps } from './cutover';
import type { ImportDeps } from './import';
import { waitNoContainers } from './live-containers';
import type { Flags, SourceRuntime } from './source';

/** Provelox's side of a migration: its API and the Docker host. Nothing here knows which platform is being left. */
export interface ProveloxEnv {
  /** Where Provelox's API is reached now. It changes when Provelox takes the standard ports. */
  apiUrl(): string;
  /** After Provelox's proxy takes 80/443: drops the port from the API address and signs in again. */
  useStandardPorts(): Promise<void>;
  call(method: string, path: string, body?: unknown): Promise<any>;
  docker: Docker;
  adapter: DockerodeAdapter;
  /** Makes sure the copy helper image is here before anything is created, so a pull problem shows at once */
  prepareHelper(): Promise<void>;
  helperImage: string;
  backupDir: string;
  importDeps(log: (l: string) => void): ImportDeps;
  cutoverDeps(runtime: SourceRuntime, log: (l: string) => void): CutoverDeps;
}

/** How long one call to the API may take. Applying an app is seconds; this is only to end a wait that will never finish. */
const CALL_TIMEOUT_MS = 5 * 60_000;

export async function connectProvelox(f: Flags): Promise<ProveloxEnv> {
  let apiUrl = (f['api-url'] as string | undefined)?.replace(/\/+$/, '');
  const password = process.env.PVX_ADMIN_PASSWORD;
  if (!apiUrl) throw new Error('--api-url is required.');
  if (!password)
    throw new Error('Set PVX_ADMIN_PASSWORD to the Provelox admin password.');

  let token = '';
  const call = async (method: string, path: string, body?: unknown) => {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A call the API never answers (it restarted while this was waiting) must not hang the run for ever
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError')
        throw new Error(
          `${method} ${path}: no answer within ${CALL_TIMEOUT_MS / 60_000} minutes. The API may have restarted: run the same command again, it carries on from where it stopped.`,
        );
      throw e;
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(
        `${method} ${path}: the API answered ${res.status} with something that is not JSON. Is --api-url right?`,
      );
    }
    if (!res.ok)
      throw new Error(
        `${method} ${path}: ${json?.error?.message ?? json?.message ?? res.status}`,
      );
    return json;
  };
  const login = async () => {
    token = '';
    token = (await call('POST', '/v1/auth/login', { password })).token;
  };
  await login();

  const socketPath = (f.socket as string) ?? '/var/run/docker.sock';
  const docker = new Docker({ socketPath });
  const adapter = new DockerodeAdapter({ DOCKER_SOCKET: socketPath } as Config);
  await adapter.ping();
  const helperImage = (f['helper-image'] as string) ?? 'busybox:latest';
  const backupDir = (f['backup-dir'] as string) ?? 'cutover-backup';

  const waitProveloxStopped = (app: string) =>
    waitNoContainers(docker, serviceName(app), app);

  return {
    apiUrl: () => apiUrl!,
    useStandardPorts: async () => {
      const u = new URL(apiUrl!);
      u.port = '';
      apiUrl = u.toString().replace(/\/+$/, '');
      // the proxy is restarting: wait for the API to answer at the new address
      for (let i = 0; i < 45; i++) {
        try {
          if ((await fetch(`${apiUrl}/health`)).ok) return login();
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(
        `Provelox did not answer at ${apiUrl} after taking ports 80 and 443.`,
      );
    },
    call,
    docker,
    adapter,
    /** Makes sure the copy helper image is here before anything is created, so a pull problem shows at once */
    prepareHelper: () => adapter.prepareImage(helperImage),
    helperImage,
    backupDir,
    importDeps: (log) => ({
      api: (m, p, b) => call(m, p, b),
      appExists: async (name) =>
        ((await call('GET', '/v1/apps')) as { app: { name: string } }[]).some(
          (v) => v.app.name === name,
        ),
      appAliases: async (name) =>
        (
          (await call('GET', '/v1/apps')) as {
            app: { name: string; aliases?: string[] };
          }[]
        ).find((v) => v.app.name === name)?.app.aliases ?? null,
      volumeExists: (n) => adapter.volumeExists(n),
      createVolume: (n, l) => adapter.createVolume(n, l),
      runHelper: (s) => adapter.runHelper(s),
      helperImage,
      log,
    }),
    cutoverDeps: (runtime, log) => ({
      stopOld: (app) => runtime.stopApp(app),
      waitStopped: (app, platform) =>
        platform === 'old'
          ? runtime.waitStopped(app)
          : waitProveloxStopped(app),
      api: (m, p, b) => call(m, p, b),
      getApp: async (name) => (await call('GET', `/v1/apps/${name}`)).app,
      runHelper: (s) => adapter.runHelper(s),
      helperImage,
      log,
    }),
  };
}
