import type { ImportPlan } from './import';

export interface Check {
  app: string;
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface AppFacts {
  app: {
    name: string;
    image: string;
    instanceCount: number;
    exposed: boolean;
    aliases: string[];
    ports: { hostPort: number; protocol: string }[];
    pendingPorts: { hostPort: number; protocol: string }[];
    volumes: { volumeName?: string }[];
  };
  status: { state: string; running: number; desired: number } | null;
}

export interface VerifyDeps {
  getApp(name: string): Promise<AppFacts | null>;
  volumeExists(name: string): Promise<boolean>;
  /** The HTTP status of the app's address on Provelox, or 0 when nothing answered. */
  http(app: string): Promise<number>;
}

const ok = (app: string, name: string, detail = ''): Check => ({
  app,
  name,
  level: 'ok',
  detail,
});
const fail = (app: string, name: string, detail: string): Check => ({
  app,
  name,
  level: 'fail',
  detail,
});
const warn = (app: string, name: string, detail: string): Check => ({
  app,
  name,
  level: 'warn',
  detail,
});

/** After the import: is everything that should exist on Provelox there, and in the state the plan promised? */
export async function verifyImported(
  plans: ImportPlan[],
  d: VerifyDeps,
  /** Apps that already went through the cutover: their ports are published, which is right for them now. */
  moved: ReadonlySet<string> = new Set(),
): Promise<Check[]> {
  const out: Check[] = [];
  for (const p of plans.filter((x) => !x.skip)) {
    const v = await d.getApp(p.name);
    if (!v) {
      out.push(fail(p.name, 'app exists', 'Not found on Provelox.'));
      continue;
    }
    out.push(ok(p.name, 'app exists'));
    out.push(
      v.app.image === p.image
        ? ok(p.name, 'image', v.app.image || '(none, as on CapRover)')
        : fail(
            p.name,
            'image',
            `Provelox has "${v.app.image}", CapRover had "${p.image}".`,
          ),
    );
    out.push(
      v.app.aliases.includes(p.patch.aliases[0])
        ? ok(p.name, 'keeps its CapRover name', p.patch.aliases[0])
        : fail(
            p.name,
            'keeps its CapRover name',
            `Missing the alias ${p.patch.aliases[0]}: references from other apps would break.`,
          ),
    );
    for (const c of p.copies)
      out.push(
        (await d.volumeExists(c.to))
          ? ok(p.name, 'data volume', c.to)
          : fail(p.name, 'data volume', `${c.to} does not exist.`),
      );
    if (moved.has(p.name)) {
      out.push(ok(p.name, 'cut over already', 'it runs on Provelox now'));
      continue;
    }
    if (p.patch.pendingPorts.length)
      out.push(
        v.app.pendingPorts.length === p.patch.pendingPorts.length
          ? ok(
              p.name,
              'host ports recorded',
              `${p.patch.pendingPorts.length} waiting for cutover`,
            )
          : fail(
              p.name,
              'host ports recorded',
              'The ports CapRover publishes are not recorded as pending.',
            ),
      );
    if (v.app.ports.length)
      out.push(
        fail(
          p.name,
          'host ports held back',
          'Ports are published already: they would clash with CapRover.',
        ),
      );
  }
  return out;
}

/** After the cutover: is each app running where it should, with its ports, answering on its address? */
export async function verifyMigrated(
  plans: ImportPlan[],
  d: VerifyDeps,
): Promise<Check[]> {
  const out: Check[] = [];
  for (const p of plans.filter((x) => !x.skip)) {
    const v = await d.getApp(p.name);
    if (!v) {
      out.push(fail(p.name, 'app exists', 'Not found on Provelox.'));
      continue;
    }
    const want = p.wantedInstances;
    const s = v.status;
    out.push(
      s && s.state === 'running' && s.running >= want
        ? ok(
            p.name,
            'running',
            `${s.running} of ${want} instance${want === 1 ? '' : 's'}`,
          )
        : fail(
            p.name,
            'running',
            `State is ${s?.state ?? 'missing'} (${s?.running ?? 0} of ${want} running).`,
          ),
    );
    if (p.patch.pendingPorts.length) {
      const published = new Set(
        v.app.ports.map((x) => `${x.hostPort}/${x.protocol}`),
      );
      const missing = p.patch.pendingPorts.filter(
        (x) => !published.has(`${x.hostPort}/${x.protocol}`),
      );
      out.push(
        missing.length === 0 && v.app.pendingPorts.length === 0
          ? ok(
              p.name,
              'host ports published',
              p.patch.pendingPorts
                .map((x) => `${x.hostPort}/${x.protocol}`)
                .join(', '),
            )
          : fail(
              p.name,
              'host ports published',
              `Not published: ${missing.map((x) => `${x.hostPort}/${x.protocol}`).join(', ') || 'still listed as pending'}.`,
            ),
      );
    }
    if (v.app.exposed && p.image) {
      const code = await d.http(p.name);
      out.push(
        code === 0 || code >= 500
          ? fail(
              p.name,
              'answers on its address',
              code === 0 ? 'No answer.' : `HTTP ${code}.`,
            )
          : code === 404
            ? warn(
                p.name,
                'answers on its address',
                'HTTP 404: the app may have no page at /, or the proxy does not route it.',
              )
            : ok(p.name, 'answers on its address', `HTTP ${code}`),
      );
    }
  }
  return out;
}

export const failures = (checks: Check[]) =>
  checks.filter((c) => c.level === 'fail');

export function formatChecks(checks: Check[]): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' } as const;
  return checks
    .map(
      (c) =>
        `  ${icon[c.level]} ${c.app}: ${c.name}${c.detail ? `: ${c.detail}` : ''}`,
    )
    .join('\n');
}
