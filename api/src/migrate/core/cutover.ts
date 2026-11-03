import { withHeartbeat } from './progress';
import type { HelperSpec } from '../../docker/docker.port';
import type { ImportPlan } from './import';

export interface CutoverStep {
  app: string;
  /** Old volume → Provelox volume, copied again while both sides are stopped. */
  finalCopies: { from: string; to: string }[];
  /** Moved from `pendingPorts` into `ports`. */
  publishPorts: {
    containerPort: number;
    hostPort: number;
    protocol: 'tcp' | 'udp';
  }[];
  /** The instance count to start with afterwards (what the old platform ran). */
  startInstances: number;
}

/** Only apps with data or host ports need a step: the others already run on Provelox and need nothing. */
export function planCutover(plans: ImportPlan[]): CutoverStep[] {
  return plans
    .filter(
      (p) =>
        !p.skip && (p.copies.length > 0 || p.patch.pendingPorts.length > 0),
    )
    .map((p) => ({
      app: p.name,
      finalCopies: p.copies.map((c) => ({ from: c.from, to: c.to })),
      publishPorts: p.patch.pendingPorts,
      startInstances: p.wantedInstances,
    }));
}

export function formatCutover(
  steps: CutoverStep[],
  source = 'the old platform',
): string {
  const lines: string[] = [];
  for (const s of steps) {
    lines.push(s.app);
    lines.push(`  stop       on ${source} and on Provelox`);
    for (const c of s.finalCopies)
      lines.push(
        `  copy       ${c.from} → ${c.to}, replacing the earlier copy, then verify`,
      );
    for (const p of s.publishPorts)
      lines.push(
        `  publish    ${p.hostPort} → ${p.containerPort}/${p.protocol}`,
      );
    lines.push(
      `  start      ${s.startInstances} instance${s.startInstances === 1 ? '' : 's'} on Provelox`,
    );
    lines.push('');
  }
  lines.push(
    `Then ${source}'s web proxy is stopped to release ports 80 and 443. ${source} stays installed: nothing is deleted.`,
    "Last, Provelox's install runs again with the standard ports so its proxy takes them.",
  );
  return lines.join('\n');
}

export interface CutoverDeps {
  /** Stops an app on the old platform and frees its host ports. Returns how to put it back exactly as it was. */
  stopOld(app: string): Promise<{ restore(): Promise<void> }>;
  /** Resolves once the app has no running instances, on either platform. */
  waitStopped(app: string, platform: 'old' | 'provelox'): Promise<void>;
  api(method: string, path: string, body?: unknown): Promise<unknown>;
  getApp(name: string): Promise<{
    instanceCount: number;
    ports: unknown[];
    pendingPorts: unknown[];
  }>;
  runHelper(spec: HelperSpec): Promise<{ exitCode: number; output: string }>;
  helperImage: string;
  log(line: string): void;
  /** Called as soon as an app has moved, so progress survives a later failure or a lost terminal. */
  moved?(app: string): void;
}

export interface CutoverResult {
  done: string[];
  failed?: { app: string; reason: string };
  /** Old-platform apps started again after a failure. */
  restored: string[];
}

/**
 * Runs the per-app cutover. For each app: stop it on both platforms, copy the data again (a mirror: the earlier copy is
 * replaced, then verified), publish its host ports, start it on Provelox. If a step fails, the old-platform apps this
 * run stopped are started again, so the original keeps working, and the run stops.
 */
export async function runCutover(
  steps: CutoverStep[],
  deps: CutoverDeps,
): Promise<CutoverResult> {
  const result: CutoverResult = { done: [], restored: [] };
  const stopped: { app: string; restore(): Promise<void> }[] = [];
  for (const s of steps) {
    try {
      deps.log(`${s.app}: stopping on the old platform`);
      stopped.push({ app: s.app, ...(await deps.stopOld(s.app)) });
      await deps.waitStopped(s.app, 'old');

      const cur = await deps.getApp(s.app);
      if (cur.instanceCount !== 0) {
        deps.log(`${s.app}: stopping on Provelox`);
        await deps.api('PATCH', `/v1/apps/${s.app}`, { instanceCount: 0 });
        await deps.waitStopped(s.app, 'provelox');
      }

      for (const c of s.finalCopies) {
        deps.log(`${s.app}: final copy of ${c.from}`);
        const r = await withHeartbeat(
          deps.runHelper({
            image: deps.helperImage,
            // the target is only ever our own copy; mirror it from the stopped original, then prove they match
            command: [
              'sh',
              '-c',
              'find /to -mindepth 1 -delete && cp -a /from/. /to/ && diff -r /from /to',
            ],
            mounts: [
              { volume: c.from, target: '/from', readOnly: true },
              { volume: c.to, target: '/to', readOnly: false },
            ],
          }),
          deps.log,
          `${s.app}: still copying ${c.from}`,
        );
        if (r.exitCode !== 0)
          throw new Error(
            `The final copy of ${c.from} did not verify (exit ${r.exitCode}). ${r.output.trim().slice(-300)}`,
          );
      }

      deps.log(`${s.app}: publishing ports and starting`);
      await deps.api('PATCH', `/v1/apps/${s.app}`, {
        ...(s.publishPorts.length > 0 && {
          ports: s.publishPorts,
          pendingPorts: [],
        }),
        instanceCount: s.startInstances,
      });
      result.done.push(s.app);
      deps.moved?.(s.app);
    } catch (e) {
      result.failed = {
        app: s.app,
        reason: e instanceof Error ? e.message : String(e),
      };
      break;
    }
  }
  if (result.failed) {
    for (const x of [...stopped].reverse()) {
      // apps already moved stay on Provelox; their old side stays stopped so they never run twice
      if (result.done.includes(x.app)) continue;
      await x.restore();
      result.restored.push(x.app);
    }
  }
  return result;
}
