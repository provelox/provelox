import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { install } from '../self/install';
import { formatCutover, planCutover, runCutover } from './core/cutover';
import { formatPlan, planImport, runImport } from './core/import';
import { formatInventory, inventory, inventoryJson } from './core/inventory';
import { connectProvelox } from './core/provelox';
import type { Flags, MigrationSource } from './core/source';
import { runWizard, type Ui } from './core/wizard';
import { findSource, SOURCES } from './sources';

/** Where what is printed is also written, with the time, so a dropped connection does not lose it. */
const sink: { file: string | null } = { file: null };

/** Prints a line, and writes it (with the time) to the log file when there is one. */
function say(line = '') {
  console.log(line);
  if (sink.file)
    try {
      appendFileSync(sink.file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // the screen is what matters: a log that cannot be written is not a reason to stop
    }
}

/**
 * Progress and the saved specs of everything that gets stopped are written to files. In a throwaway container
 * started from the image they would vanish on exit, and the next run would start from the beginning without
 * knowing which apps had already moved.
 */
export function assertDurable(
  f: Flags,
  inContainer = existsSync('/.dockerenv'),
  cwd = process.cwd(),
) {
  if (inContainer && cwd === '/app' && !(f['state-file'] && f['backup-dir']))
    throw new Error(
      'Progress and backups would be lost when this container exits. Mount a folder and run from it, for example: docker run --rm -it -v "$PWD":/work -w /work ... (the files are then kept in your current directory), or pass --state-file and --backup-dir paths on a mounted volume.',
    );
}

const BOOLEAN = new Set(['--apply', '--json']);

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}".`);
    if (BOOLEAN.has(a)) out[a.slice(2)] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--'))
        throw new Error(`${a} needs a value.`);
      out[a.slice(2)] = v;
    }
  }
  return out;
}

export const MIGRATE_USAGE = `Migration (move apps from another platform to this Provelox)

  Platforms: ${SOURCES.map((s) => s.id).join(', ')}   (pick one with --from; optional while there is only one)

  migrate --from <platform> --root-domain <domain> --api-url <url> [--image <name:tag>]
      The whole move as one guided, resumable run: inventory, import, test, cutover, check, then stop and remove the
      old platform. It stops for your confirmation at each step and remembers where it is (--state-file, default
      ./provelox-migration.json), so running it again carries on. Needs PVX_ADMIN_PASSWORD and the Docker socket.
  inventory --from <platform>              what the old platform runs and what moves (changes nothing; --json for data)
  import --from <platform> [--apply]       preview, or with --apply do, the import of its apps
  cutover --from <platform> [--apply]      move apps with data or host ports over, then stop its proxy

  Common: --api-url <url> (this Provelox's API as reachable from here), --helper-image <image>, --backup-dir <dir>
          (where the specs of everything stopped are saved, default ./cutover-backup), --only <app,app> (import)
${SOURCES.map((s) => `\n  ${s.title} (--from ${s.id}):\n${s.options.map((o) => `      ${o.flag}  ${o.description}`).join('\n')}`).join('\n')}
`;

export const MIGRATE_COMMANDS = ['migrate', 'inventory', 'import', 'cutover'];

export async function runMigrationCommand(
  command: string,
  argv: string[],
): Promise<number> {
  const f = parseFlags(argv);
  const source = findSource(f.from as string | undefined);
  if (command === 'inventory') return runInventory(source, f);
  if (command === 'import') return runImportCommand(source, f);
  if (command === 'cutover') return runCutoverCommand(source, f);
  return runMigrate(source, f);
}

async function runInventory(source: MigrationSource, f: Flags) {
  const inv = inventory(await source.read(f));
  say(
    f.json ? JSON.stringify(inventoryJson(inv), null, 2) : formatInventory(inv),
  );
  return 0;
}

async function runImportCommand(source: MigrationSource, f: Flags) {
  let plans = planImport(await source.read(f));
  if (f.only)
    plans = plans.filter((p) => (f.only as string).split(',').includes(p.name));
  say(formatPlan(plans));
  if (!f.apply) {
    say('\nThis was a preview: nothing was changed. Add --apply to import.');
    return 0;
  }
  assertDurable(f);
  const env = await connectProvelox(f);
  const r = await runImport(
    plans,
    env.importDeps((l) => say(l)),
    source.title,
  );
  say(`\nImported: ${r.imported.join(', ') || 'none'}`);
  for (const s of r.skipped) say(`Skipped ${s.name}: ${s.reason}`);
  for (const x of r.failed) say(`FAILED ${x.name}: ${x.reason}`);
  return r.failed.length ? 1 : 0;
}

async function runCutoverCommand(source: MigrationSource, f: Flags) {
  const steps = planCutover(planImport(await source.read(f)));
  say(formatCutover(steps, source.title));
  if (!f.apply) {
    say('\nThis was a preview: nothing was changed. Add --apply to run it.');
    return 0;
  }
  assertDurable(f);
  const env = await connectProvelox(f);
  const runtime = source.runtime({
    docker: env.docker,
    backupDir: env.backupDir,
  });
  const result = await runCutover(
    steps,
    env.cutoverDeps(runtime, (l) => say(l)),
  );
  if (result.failed) {
    say(`\nFAILED ${result.failed.app}: ${result.failed.reason}`);
    say(
      `${source.title} apps started again: ${result.restored.join(', ') || 'none'}. Its proxy was not touched.`,
    );
    return 1;
  }
  say(`\nMoved: ${result.done.join(', ') || 'none'}`);
  say(`Stopping ${source.title}'s proxy`);
  await runtime.stopProxy();
  say(
    '\nNow give Provelox the standard ports:\n  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock <image> install --root-domain <domain> --http-port 80 --https-port 443\nTo roll back, put the saved services back from the backup folder (docker service update), and stop the Provelox proxy.',
  );
  return 0;
}

/** `migrate`: the whole move as one guided, resumable run. */
async function runMigrate(source: MigrationSource, f: Flags) {
  const rootDomain = f['root-domain'] as string | undefined;
  if (!rootDomain)
    throw new Error(
      '--root-domain is required: the domain apps are served at on Provelox (normally the one the old platform used).',
    );
  const apps = await source.read(f);
  assertDurable(f);
  sink.file = (f['log-file'] as string) ?? 'provelox-migration.log';
  const env = await connectProvelox(f);
  const image =
    (f.image as string | undefined) ?? (await env.adapter.selfImage());
  if (!image)
    throw new Error(
      'Pass --image <name:tag>: the Provelox image to install again at the end, when Provelox takes ports 80 and 443.',
    );
  const runtime = source.runtime({
    docker: env.docker,
    backupDir: env.backupDir,
  });
  say(
    `Everything printed is also written to ${sink.file}, with the time. Copying a big volume can take a long time and prints a line every few seconds. Run this inside tmux or screen: if your connection drops, the command stops with it, but running it again carries on from where it was (progress is kept in the state file).`,
  );
  // Before anything is created: a copy helper that cannot be pulled is found now, not halfway through
  try {
    await env.prepareHelper();
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : e} Nothing was changed. Use --helper-image to name an image that is already on this server.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => (await rl.question(`${q} `)).trim();
  const ui: Ui = {
    say: (t) => say(t),
    confirm: async (q) => /^y(es)?$/i.test(await ask(`${q} [y/N]`)),
    typed: async (q, word) => (await ask(`${q}:`)) === word,
  };
  const stateFile = (f['state-file'] as string) ?? 'provelox-migration.json';
  const store = {
    load: () => {
      try {
        return JSON.parse(readFileSync(stateFile, 'utf8'));
      } catch {
        return { completed: [] as string[] };
      }
    },
    save: (s: { completed: string[] }) =>
      writeFileSync(stateFile, JSON.stringify(s, null, 2)),
  };
  const port = () => new URL(env.apiUrl()).port;
  const appUrl = (app: string) =>
    `http://${app}.${rootDomain}${port() ? `:${port()}` : ''}`;
  try {
    const result = await runWizard({
      sourceTitle: source.title,
      apps,
      ui,
      store,
      runtime,
      importDeps: env.importDeps((l) => say(`  ${l}`)),
      cutoverDeps: env.cutoverDeps(runtime, (l) => say(`  ${l}`)),
      verify: {
        getApp: async (name) => {
          try {
            return await env.call('GET', `/v1/apps/${name}`);
          } catch {
            return null;
          }
        },
        volumeExists: (n) => env.adapter.volumeExists(n),
        http: async (app) => {
          try {
            return (
              await fetch(appUrl(app) + '/', {
                signal: AbortSignal.timeout(8000),
                redirect: 'manual',
              })
            ).status;
          } catch {
            return 0;
          }
        },
      },
      appUrl,
      startApp: async (app, instances) => {
        await env.call('PATCH', `/v1/apps/${app}`, {
          instanceCount: instances,
        });
      },
      takeStandardPorts: async () => {
        await install(env.adapter, {
          rootDomain,
          httpPort: 80,
          httpsPort: 443,
          acmeEmail: f['acme-email'] as string | undefined,
          image,
        });
        await env.useStandardPorts();
      },
      settle: () => new Promise((r) => setTimeout(r, 15_000)),
    });
    return result === 'finished' ? 0 : 2;
  } finally {
    rl.close();
  }
}
