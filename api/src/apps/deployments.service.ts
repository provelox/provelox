import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { serviceName } from '../common/naming';
import { DOCKER, type DockerPort } from '../docker/docker.port';

export interface DeploymentState {
  app: string;
  version: number;
  image: string;
  isBuilding: boolean;
  isFailed: boolean;
  lines: string[];
  startedAt: string;
  finishedAt?: string;
}

const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60_000;

/**
 * Follows a deploy until it settles. Swarm rolls a service onto the new image on its own; this watches the
 * tasks and turns what it sees into a short log the console can show.
 */
@Injectable()
export class DeploymentsService implements OnModuleDestroy {
  private readonly states = new Map<string, DeploymentState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(@Inject(DOCKER) private readonly docker: DockerPort) {}

  get(app: string): DeploymentState | null {
    return this.states.get(app) ?? null;
  }

  /** Starts following a deploy. A newer deploy of the same app replaces the one being followed. */
  track(
    app: string,
    version: number,
    image: string,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ) {
    clearTimeout(this.timers.get(app));
    const state: DeploymentState = {
      app,
      version,
      image,
      isBuilding: true,
      isFailed: false,
      lines: [`Deploying ${image} (version ${version})`],
      startedAt: new Date().toISOString(),
    };
    this.states.set(app, state);
    const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS);
    const tick = async () => {
      if (this.states.get(app) !== state) return; // superseded
      const done = await this.step(state, Date.now() > deadline);
      if (!done) {
        const t = setTimeout(tick, opts.pollMs ?? POLL_MS);
        t.unref();
        this.timers.set(app, t);
      }
    };
    void tick();
  }

  /** One look at Docker. Returns true once the deploy has finished, successfully or not. */
  async step(state: DeploymentState, timedOut = false): Promise<boolean> {
    const log = (line: string) => {
      if (state.lines[state.lines.length - 1] !== line) state.lines.push(line);
    };
    const finish = (failed: boolean) => {
      state.isBuilding = false;
      state.isFailed = failed;
      state.finishedAt = new Date().toISOString();
      return true;
    };
    try {
      const s = await this.docker.serviceStatus(serviceName(state.app));
      if (!s) {
        log('The service does not exist.');
        return finish(true);
      }
      if (s.updateState?.startsWith('rollback')) {
        log('Docker rolled the update back: the new version did not start.');
        if (s.message) log(s.message);
        if (/no matching manifest/i.test(s.message ?? ''))
          log(
            "The image was not built for this server's CPU. Publish it for that platform too (for example linux/amd64 and linux/arm64) and deploy again.",
          );
        return finish(true);
      }
      if (s.state === 'failed') {
        log(
          `The containers keep failing to start${s.message ? `: ${s.message}` : '.'}`,
        );
        return finish(true);
      }
      if (s.state === 'running' && s.updateState !== 'updating') {
        log(
          `Running: ${s.running}/${s.desired} instance${s.desired === 1 ? '' : 's'}.`,
        );
        return finish(false);
      }
      if (s.state === 'stopped') {
        log('Deployed, the app is scaled to zero instances.');
        return finish(false);
      }
      log(`Starting: ${s.running}/${s.desired} instances running…`);
    } catch (e) {
      log(
        `Could not read the service status: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
    if (timedOut) {
      log(
        'Gave up waiting after 10 minutes. The service may still be starting.',
      );
      return finish(true);
    }
    return false;
  }

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
  }
}
