import { withHeartbeat } from './progress';
import { volumeName as proveloxVolume } from '../../common/naming';
import type { HelperSpec } from '../../docker/docker.port';
import type { SourceApp } from './source';

/** What the importer sends to Provelox for one app, and what it will not do. */
export interface ImportPlan {
  name: string;
  /** Not imported: the reason. The app stays on the old platform. */
  skip?: string;
  persistent: boolean;
  image: string;
  /** What the old platform ran. Imported apps with host ports or data start at 0 and are started by hand. */
  wantedInstances: number;
  startStopped: boolean;
  patch: {
    containerPort: number;
    exposed: boolean;
    instanceCount: number;
    env: { key: string; value: string }[];
    ports: {
      containerPort: number;
      hostPort: number;
      protocol: 'tcp' | 'udp';
    }[];
    /** Host ports the old platform holds. Swarm refuses a second service on a published port even at zero instances, so they are only recorded here and published at cutover. */
    pendingPorts: {
      containerPort: number;
      hostPort: number;
      protocol: 'tcp' | 'udp';
    }[];
    volumes: { containerPath: string; volumeName: string }[];
    domains: { host: string; ssl: false }[];
    /** The address the others redirect to, carried over from the old platform's redirect domain. */
    primaryDomain?: string;
    /** HTTP basic auth carried over: a hash the proxy reads, or the password itself (hashed on Provelox) */
    basicAuth?: {
      users: (
        { name: string; hash: string } | { name: string; password: string }
      )[];
      openPaths: string[];
    };
    aliases: string[];
  };
  /** Old volume → the Provelox volume that receives a copy of it. */
  copies: { from: string; to: string; containerPath: string }[];
  /** What was left out or changed, for the preview. */
  warnings: string[];
}

export function planImport(apps: SourceApp[]): ImportPlan[] {
  return [...apps]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => {
      const warnings = [...a.warnings];
      // An app that was password protected and whose password could not be read must not start unprotected
      const authLost = !!a.httpAuth && !a.httpAuth.hash && !a.httpAuth.password;
      const stopped = a.hostPorts.length > 0 || a.persistent || authLost;
      if (authLost)
        warnings.push(
          'Created stopped: it had a password on CapRover that could not be carried over. Set one (Networking → Password protection), then start it.',
        );
      const wanted = a.persistent ? 1 : a.instanceCount;
      if (a.persistent && a.instanceCount > 1)
        warnings.push('Persistent apps run one instance on Provelox.');
      if (a.forceSsl)
        warnings.push(
          'Force HTTPS was not carried over: turn on HTTPS on Provelox first.',
        );
      if (a.domains.some((d) => d.ssl))
        warnings.push(
          'Domains were added without HTTPS: turn it on once Provelox holds port 80.',
        );
      if (!a.image)
        warnings.push('Nothing is deployed there: the app is created empty.');

      const named = a.volumes.filter((v) => v.volume && v.name);
      return {
        name: a.name,
        skip: a.blocker,
        persistent: a.persistent,
        image: a.image,
        wantedInstances: wanted,
        startStopped: stopped,
        patch: {
          containerPort: a.containerPort,
          exposed: a.exposed,
          instanceCount: stopped ? 0 : wanted,
          env: a.env,
          ports: [],
          pendingPorts: a.hostPorts,
          volumes: named.map((v) => ({
            containerPath: v.containerPath,
            volumeName: v.name!,
          })),
          domains: a.domains.map((d) => ({
            host: d.host,
            ssl: false as const,
          })),
          ...(a.primaryDomain && { primaryDomain: a.primaryDomain }),
          ...(a.httpAuth?.hash || a.httpAuth?.password
            ? {
                basicAuth: {
                  users: [
                    a.httpAuth.hash
                      ? { name: a.httpAuth.user, hash: a.httpAuth.hash }
                      : {
                          name: a.httpAuth.user,
                          password: a.httpAuth.password!,
                        },
                  ],
                  openPaths: [],
                },
              }
            : {}),
          aliases: [a.alias],
        },
        copies: named.map((v) => ({
          from: v.volume!,
          to: proveloxVolume(a.name, v.name!),
          containerPath: v.containerPath,
        })),
        warnings,
      };
    });
}

export function formatPlan(plans: ImportPlan[]): string {
  const lines: string[] = [];
  for (const p of plans) {
    if (p.skip) {
      lines.push(`${p.name}  SKIPPED: ${p.skip}`, '');
      continue;
    }
    lines.push(`${p.name}`);
    lines.push(
      `  create     ${p.persistent ? 'persistent ' : ''}app, ${p.image ? `image ${p.image}` : 'no image'}, port ${p.patch.containerPort}`,
    );
    lines.push(
      `  start      ${p.startStopped ? `stopped (it ran ${p.wantedInstances}); start it after testing` : `${p.patch.instanceCount} instance${p.patch.instanceCount === 1 ? '' : 's'}`}`,
    );
    if (p.patch.env.length)
      lines.push(`  env        ${p.patch.env.map((e) => e.key).join(', ')}`);
    for (const c of p.copies)
      lines.push(`  copy       ${c.from} → ${c.to} (read-only source)`);
    for (const x of p.patch.pendingPorts)
      lines.push(
        `  host port  ${x.hostPort} → ${x.containerPort}/${x.protocol}: recorded as pending, published at cutover`,
      );
    if (p.patch.primaryDomain)
      lines.push(
        `  redirect   the other addresses go to ${p.patch.primaryDomain}`,
      );
    if (p.patch.basicAuth)
      lines.push(
        `  password   HTTP basic auth carried over for ${p.patch.basicAuth.users.map((u) => u.name).join(', ')}`,
      );
    lines.push(`  alias      ${p.patch.aliases.join(', ')}`);
    for (const w of p.warnings) lines.push(`  ! ${w}`);
    lines.push('');
  }
  const todo = plans.filter((p) => !p.skip).length;
  lines.push(`${todo} of ${plans.length} apps will be imported.`);
  return lines.join('\n');
}

/** What the executor needs: Provelox's HTTP API and the Docker host. Injected so the sequence is testable. */
export interface ImportDeps {
  api(method: string, path: string, body?: unknown): Promise<unknown>;
  appExists(name: string): Promise<boolean>;
  /**
   * The extra names an existing app has, or null when there is no such app. The import sets the old platform's name as
   * one, so an app without it never got its settings (an import that stopped halfway) and is finished, not skipped.
   */
  appAliases?(name: string): Promise<string[] | null>;
  volumeExists(name: string): Promise<boolean>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  runHelper(spec: HelperSpec): Promise<{ exitCode: number; output: string }>;
  helperImage: string;
  log(line: string): void;
}

export interface ImportResult {
  imported: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
}

/**
 * Creates each app on Provelox and copies its data. Never touches the old platform (its volumes are mounted read-only)
 * and never changes an app that already exists on Provelox. One app failing does not stop the others.
 */
export async function runImport(
  plans: ImportPlan[],
  deps: ImportDeps,
  source = 'the old platform',
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [], failed: [] };
  for (const p of plans) {
    if (p.skip) {
      result.skipped.push({ name: p.name, reason: p.skip });
      continue;
    }
    let created = false;
    try {
      if (await deps.appExists(p.name)) {
        const aliases = await deps.appAliases?.(p.name);
        // Created by an earlier import that failed before its settings, environment and image went on: finish it
        if (!aliases || aliases.includes(p.patch.aliases[0])) {
          result.skipped.push({
            name: p.name,
            reason: 'An app with this name already exists on Provelox.',
          });
          continue;
        }
        deps.log(`${p.name}: finishing an import that stopped halfway`);
      } else {
        deps.log(`${p.name}: creating`);
        await deps.api('POST', '/v1/apps', {
          name: p.name,
          persistent: p.persistent,
        });
        created = true;
      }
      // Volumes are made here, with the labels the platform gives its own, so the copy lands in the volume the app
      // will mount.
      for (const c of p.copies) {
        if (!(await deps.volumeExists(c.from)))
          throw new Error(`${source}'s volume ${c.from} does not exist.`);
        if (!(await deps.volumeExists(c.to)))
          await deps.createVolume(c.to, {
            'io.provelox.app': p.name,
            'io.provelox.migrated-from': c.from,
          });
        deps.log(`${p.name}: copying ${c.from}`);
        const r = await withHeartbeat(
          deps.runHelper({
            image: deps.helperImage,
            // The target is only ever our own copy, so it is emptied first: a run that failed earlier leaves files
            // (a database's pid file, say) that the source has since lost, and they would otherwise stay behind.
            // Only a failed copy fails the step. The source keeps running during this copy, so a database rewrites
            // its files while they are read; that shows up as differences and is reported, not refused. The copy at
            // cutover reads the stopped original and must match exactly.
            command: [
              'sh',
              '-c',
              'find /to -mindepth 1 -delete && cp -a /from/. /to/ || exit 3; diff -r /from /to; exit 0',
            ],
            mounts: [
              { volume: c.from, target: '/from', readOnly: true },
              { volume: c.to, target: '/to', readOnly: false },
            ],
          }),
          deps.log,
          `${p.name}: still copying ${c.from}`,
        );
        if (r.exitCode !== 0)
          throw new Error(
            `Copying ${c.from} failed (exit ${r.exitCode}). ${r.output.trim().slice(-300)}`,
          );
        const differing = r.output
          .split('\n')
          .filter((l) => /^(Files .* differ|Only in )/.test(l)).length;
        if (differing > 0)
          deps.log(
            `${p.name}: ${differing} file${differing === 1 ? '' : 's'} changed while copying ${c.from}, which is normal while ${source} runs it. This is a copy for testing; the copy at cutover is made from the stopped app and checked exactly.`,
          );
      }
      await deps.api('PATCH', `/v1/apps/${p.name}`, {
        ...p.patch,
        volumes: p.patch.volumes.map((v) => ({ ...v, readOnly: false })),
      });
      if (p.image) {
        deps.log(`${p.name}: deploying ${p.image}`);
        await deps.api('POST', `/v1/apps/${p.name}/deploy`, { image: p.image });
      }
      result.imported.push(p.name);
    } catch (e) {
      // An app left half-made would be skipped as "already exists" on the next run and stay without its settings, its
      // image and its CapRover name. Take it away (its copied data stays) so running the import again redoes it.
      if (created)
        await deps.api('DELETE', `/v1/apps/${p.name}`).catch(() => undefined);
      result.failed.push({
        name: p.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}
