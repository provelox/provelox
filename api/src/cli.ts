import { DockerodeAdapter } from './docker/dockerode.adapter';
import { bootstrap, type BootstrapOptions } from './self/bootstrap';
import { install } from './self/install';
import { joinCluster } from './self/join';
import { resetAdminPassword } from './self/reset-password';
import {
  detach,
  planDetach,
  planUninstall,
  uninstall,
  type DetachPlan,
  type UninstallPlan,
} from './self/uninstall';
import {
  MIGRATE_COMMANDS,
  MIGRATE_USAGE,
  runMigrationCommand,
} from './migrate/commands';
import type { Config } from './config/config';

const USAGE = `Provelox

  install --root-domain <domain> [options]   set up (or upgrade) the whole platform from this image
  join --token <token> --manager <host:port> join this machine to another one's cluster
  encrypt-network [--network <name>]         encrypt the network apps talk over (for a cluster across the internet)
  reset-password                             set a new admin password (when the old one is lost)
  detach [--yes]                             make apps independent of Provelox's API, so it can be removed
  uninstall [--remove-apps [--delete-data]] [--yes]   remove Provelox, leaving the apps running (shows the plan without --yes)

${MIGRATE_USAGE}
Lost the admin password? Run this with the platform's data volume mounted (no Docker socket needed):
  docker run --rm -v pvx-provelox-data:/data <image> reset-password
It prints a new password once and signs everyone out. To choose it, set PVX_NEW_PASSWORD.

Add a server to a cluster (run on the machine that is joining; the manager shows the exact command under
Settings → Infrastructure):
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock <image> join \
    --token SWMTKN-1-... --manager 10.0.0.1:2377 [--advertise-addr <this machine's ip>]

Remove Provelox (both run on a Swarm manager, show the plan first and change nothing without --yes):
  detach                     takes the API-defined error-page step out of every app's routes (labels only, nothing
                             restarts), so the apps keep answering once the API is gone
  uninstall                  detach, then remove only the console and API. Apps, proxy and data stay running.
  uninstall --remove-apps    also stop and remove the apps and the proxy (they are down until Provelox is installed
                             again), the platform's own secrets, configs and networks. Volumes and apps' secrets
                             stay unless you add --delete-data. The Swarm is never left.

Typical install, from the image itself:
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock <image> install \\
    --root-domain example.com --acme-email you@example.com

install options:
  --root-domain <domain>     apps are served at <app>.<domain> (required)
  --acme-email <email>       turns on HTTPS (Let's Encrypt) for the console and API
  --advertise-addr <ip>      when Docker cannot pick this machine's address for a new Swarm
  --api-host / --console-host <host>   defaults: api.<domain> and console.<domain>
  --http-port / --https-port <n>       host ports (default 80 / 443)
  --registry-user <name>     sign in to the registry the image comes from, when it is private (the password is read
                             from PVX_REGISTRY_PASSWORD). Needed on every install and upgrade.
  --acme-staging, --traefik-image <image>, --image <image>, --socket <path>

bootstrap options:

Options:
  --root-domain <domain>     apps are served at <app>.<domain>
  --api-host <host>          serve the API itself at this host
  --api-ssl                  HTTPS for the API host (needs --acme-email)
  --acme-email <email>       Let's Encrypt account email
  --acme-staging             use Let's Encrypt's staging CA
  --console-image <image>    also install the web console as a platform service
  --console-host <host>      where it is served (default console.<root-domain>)
  --console-ssl              HTTPS for the console (needs --acme-email)
  --http-port <n>            host port for HTTP (default 80)
  --https-port <n>           host port for HTTPS (default 443)
  --traefik-image <image>
  --socket <path>            Docker socket (default /var/run/docker.sock)

The first admin password is read from PVX_ADMIN_PASSWORD (never a command-line argument, which other users of the
machine could see). If it is not set, the API generates one and prints it once to its log:
  docker service logs pvx-provelox 2>&1 | grep "admin password"
`;

function parse(argv: string[]) {
  const flags = new Set([
    '--api-ssl',
    '--acme-staging',
    '--console-ssl',
    '--yes',
    '--remove-apps',
    '--delete-data',
  ]);
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}".`);
    if (flags.has(a)) out[a.slice(2)] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--'))
        throw new Error(`${a} needs a value.`);
      out[a.slice(2)] = v;
    }
  }
  return out;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === 'install') return runInstall(rest);
  if (command === 'reset-password') return runResetPassword(rest);
  if (command === 'join') return runJoin(rest);
  if (command === 'detach') return runDetach(rest);
  if (command === 'uninstall') return runUninstall(rest);
  if (command === 'encrypt-network') return runEncryptNetwork(rest);
  if (MIGRATE_COMMANDS.includes(command))
    return runMigrationCommand(command, rest);
  if (command !== 'bootstrap') {
    console.log(USAGE);
    return command ? 1 : 0;
  }
  const f = parse(rest);
  if (!f.image) throw new Error('--image is required.');
  const num = (k: string) => (f[k] === undefined ? undefined : Number(f[k]));
  const opts: BootstrapOptions = {
    image: f.image as string,
    rootDomain: f['root-domain'] as string | undefined,
    apiHost: f['api-host'] as string | undefined,
    apiSsl: !!f['api-ssl'],
    acmeEmail: f['acme-email'] as string | undefined,
    acmeStaging: !!f['acme-staging'],
    httpPort: num('http-port'),
    httpsPort: num('https-port'),
    traefikImage: f['traefik-image'] as string | undefined,
    consoleImage: f['console-image'] as string | undefined,
    consoleHost: f['console-host'] as string | undefined,
    consoleSsl: !!f['console-ssl'],
    adminPassword: process.env.PVX_ADMIN_PASSWORD || undefined,
  };
  const docker = new DockerodeAdapter({
    DOCKER_SOCKET: (f.socket as string) ?? '/var/run/docker.sock',
  } as Config);
  await docker.ping();
  const r = await bootstrap(docker, opts);
  console.log(
    `Provelox API ${r.action === 'created' ? 'installed' : 'upgraded'}.`,
  );
  if (r.console)
    console.log(
      `Console ${r.console === 'created' ? 'installed' : 'upgraded'}.`,
    );
  if (r.action === 'created' && !opts.adminPassword)
    console.log(
      'No admin password was given: it is generated on first start. Read it with:\n  docker service logs pvx-provelox 2>&1 | grep "admin password"',
    );
  return 0;
}

async function runEncryptNetwork(argv: string[]) {
  const f = parse(argv);
  const docker = new DockerodeAdapter({
    DOCKER_SOCKET: (f.socket as string) ?? '/var/run/docker.sock',
  } as Config);
  await docker.ping();
  if ((await docker.swarmState()) !== 'manager')
    throw new Error('Run this on a Swarm manager.');
  const names = f.network
    ? [f.network as string]
    : await docker.unencryptedNetworks();
  if (names.length === 0) {
    console.log('Every network Provelox made is already encrypted.');
    return 0;
  }
  console.log(
    `Encrypting ${names.join(', ')}. Apps on them restart one by one and are unreachable for a moment.`,
  );
  for (const name of names) {
    const r = await docker.encryptNetwork(name);
    console.log(
      r.services.length > 0
        ? `${name}: encrypted. Put back: ${r.services.join(', ')}`
        : `${name}: already encrypted.`,
    );
  }
  return 0;
}

async function runJoin(argv: string[]) {
  const f = parse(argv);
  if (!f.token || !f.manager)
    throw new Error('join needs --token and --manager <host:port>.');
  const docker = new DockerodeAdapter({
    DOCKER_SOCKET: (f.socket as string) ?? '/var/run/docker.sock',
  } as Config);
  await docker.ping();
  const r = await joinCluster(docker, {
    token: f.token as string,
    manager: f.manager as string,
    advertiseAddr: f['advertise-addr'] as string | undefined,
  });
  console.log(
    `Joined the cluster of ${r.manager}. It shows under Settings → Infrastructure on the manager.`,
  );
  return 0;
}

async function runResetPassword(argv: string[]) {
  if (argv.length > 0)
    throw new Error(
      'reset-password takes no arguments. To choose the password, set PVX_NEW_PASSWORD.',
    );
  const r = resetAdminPassword(
    process.env.DATA_DIR ?? '/data',
    process.env.PVX_NEW_PASSWORD || undefined,
  );
  console.log('The admin password was reset. Everyone has been signed out.');
  if (r.generated)
    console.log(
      `\n  New admin password (shown once, keep it somewhere safe):\n    ${r.password}`,
    );
  return 0;
}

async function managerDocker(f: Record<string, string | boolean>) {
  const docker = new DockerodeAdapter({
    DOCKER_SOCKET: (f.socket as string) ?? '/var/run/docker.sock',
  } as Config);
  await docker.ping();
  if ((await docker.swarmState()) !== 'manager')
    throw new Error('Run this on a Swarm manager.');
  return docker;
}

function describeDetach(plan: DetachPlan) {
  if (plan.apps.length === 0)
    console.log('No app depends on the API for its routes.');
  for (const a of plan.apps)
    console.log(`  ${a.service}: ${a.changes.length} route label(s) change`);
  if (plan.signIn.length > 0)
    console.log(
      `\nThese apps use "Sign in with…", which needs the API, so they are left alone and will refuse visitors once it is gone:\n  ${plan.signIn.join(', ')}`,
    );
}

async function runDetach(argv: string[]) {
  const f = parse(argv);
  const docker = await managerDocker(f);
  const plan = planDetach(await docker.managedObjects());
  describeDetach(plan);
  if (plan.apps.length === 0) return 0;
  if (!f.yes) {
    console.log('\nNothing was changed. Add --yes to do it.');
    return 0;
  }
  const done = await detach(docker, plan);
  console.log(`\nDetached ${done.length} app(s). Nothing was restarted.`);
  return 0;
}

function describeUninstall(plan: UninstallPlan) {
  if (plan.detach) describeDetach(plan.detach);
  if (plan.stops.length > 0) {
    console.log(
      `\nWARNING: these apps STOP, and run again only after you install Provelox again. To leave the apps running, run uninstall without --remove-apps.`,
    );
    for (const a of plan.stops)
      console.log(
        `  ${a.service}  ${a.image}${a.moving ? '   <- moving tag: it may come back as a newer image' : ''}`,
      );
  }
  console.log(plan.remove.length ? '\nWill remove:' : '\nNothing to remove.');
  for (const r of plan.remove) console.log(`  ${r.kind} ${r.name}`);
  if (plan.keptVolumes.length)
    console.log(`\nKept: volumes ${plan.keptVolumes.join(', ')}`);
  if (plan.keptSecrets.length)
    console.log(
      `Kept: app secrets ${plan.keptSecrets.join(', ')} (a secret's value is kept only by Docker, so it is not deleted without --delete-data)`,
    );
}

async function runUninstall(argv: string[]) {
  const f = parse(argv);
  if (f['delete-data'] && !f['remove-apps'])
    throw new Error(
      '--delete-data only goes with --remove-apps: without it the apps, their data and secrets are left as they are.',
    );
  const docker = await managerDocker(f);
  const plan = planUninstall(await docker.managedObjects(), {
    removeApps: !!f['remove-apps'],
    deleteData: !!f['delete-data'],
  });
  describeUninstall(plan);
  if (plan.remove.length === 0) return 0;
  if (!f.yes) {
    console.log('\nNothing was changed. Add --yes to do it.');
    return 0;
  }
  const r = await uninstall(docker, plan);
  console.log(`\nRemoved ${r.removed.length} object(s).`);
  if (r.left.length > 0) {
    console.log('Left behind (remove by hand):');
    for (const l of r.left) console.log(`  ${l}`);
    return 1;
  }
  return 0;
}

async function runInstall(argv: string[]) {
  const f = parse(argv);
  const num = (k: string) => (f[k] === undefined ? undefined : Number(f[k]));
  const docker = new DockerodeAdapter({
    DOCKER_SOCKET: (f.socket as string) ?? '/var/run/docker.sock',
  } as Config);
  await docker.ping();
  const r = await install(docker, {
    rootDomain: f['root-domain'] as string,
    acmeEmail: f['acme-email'] as string | undefined,
    acmeStaging: !!f['acme-staging'],
    apiHost: f['api-host'] as string | undefined,
    consoleHost: f['console-host'] as string | undefined,
    httpPort: num('http-port'),
    httpsPort: num('https-port'),
    traefikImage: f['traefik-image'] as string | undefined,
    advertiseAddr: f['advertise-addr'] as string | undefined,
    image: f.image as string | undefined,
    adminPassword: process.env.PVX_ADMIN_PASSWORD || undefined,
    registryUser: f['registry-user'] as string | undefined,
    registryPassword: process.env.PVX_REGISTRY_PASSWORD || undefined,
  });
  const verb = r.action === 'created' ? 'installed' : 'upgraded';
  if (r.swarmCreated) console.log('Started a Docker Swarm on this host.');
  console.log(`Provelox ${verb} from ${r.image}.`);
  console.log(`\n  Console   ${r.consoleUrl}\n  API       ${r.apiUrl}`);
  if (r.existingData)
    console.log(
      '\nFound the data of an earlier install and kept it: sign in with the admin password you already had. Your apps are\nre-created from it, with their settings and variables. An app secret Docker no longer holds (after leaving the Swarm, or\n`uninstall --delete-data`) has to be set again.',
    );
  if (r.generatedPassword)
    console.log(
      `\n  Admin password (shown once, keep it somewhere safe):\n    ${r.generatedPassword}`,
    );
  if (r.insecure)
    console.log(
      '\nWarning: HTTPS is off, so passwords and tokens travel unencrypted. Re-run with --acme-email to turn it on.',
    );
  else
    console.log(
      '\nHTTPS certificates are requested on first use and can take up to a minute. If the browser warns about the certificate right after installing, wait a moment and reload.',
    );
  console.log(
    '\nPoint a wildcard DNS record (*.<root-domain>) at this server so apps are reachable.',
  );
  return 0;
}

/** Entry for `node dist/cli.js` and for the image's entrypoint. */
export function runCli(argv: string[]) {
  return main(argv).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}

if (require.main === module) void runCli(process.argv.slice(2));
