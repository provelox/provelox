# Command line

The image's entrypoint runs the command line, so each command is `docker run ghcr.io/provelox/provelox:latest <command>` (written `<image>` below). From a source checkout
it is `node dist/cli.js <command>`. Run it with no command to print the usage text.

The migration commands need the Docker socket and, to read the old platform's data, a read-only mount of its folder:

```bash
docker run --rm -it -v "$PWD":/work -w /work -v /var/run/docker.sock:/var/run/docker.sock -v /captain:/captain:ro \
  -e PVX_ADMIN_PASSWORD <image> migrate --from caprover --root-domain example.com --api-url http://api.example.com:8080
```

::: warning Work in progress
Only the migration commands are described here so far.
:::

## install

Sets up, or upgrades, the whole platform from the image. See [Install](/guide/install).

## join

```text
join --token <token> --manager <host:port> [--advertise-addr <ip>]
```

Run on a new server to join it to another Provelox's cluster. It checks that the server can reach the manager first,
and says which ports to open if it cannot. The manager shows the exact command under **Settings → Infrastructure →
Add a server**. See [Servers and clusters](/guide/cluster).

## encrypt-network

```text
encrypt-network [--network <name>]
```

Recreates the network apps talk over as an encrypted one, for a cluster whose servers are not on a private network.
Run it on a manager at a quiet moment: apps restart one at a time. Safe to run again if it is interrupted. See
[Servers and clusters](/guide/cluster#switching-to-an-encrypted-network).

## detach

```text
detach [--yes]
```

Makes every app independent of Provelox's API, so the API can be removed while the apps keep answering. Run it on a
Swarm manager. Each app's routes run an error-page step that fetches pages from a service the API defines; when the API
goes, the proxy drops every route that uses it. `detach` takes that step out of the routes (labels only: nothing
restarts). Without `--yes` it only lists what it would change. Apps behind _Sign in with…_ need the API, so they are
left alone and named. See [Removing Provelox](/guide/removing-provelox).

## uninstall

```text
uninstall [--remove-apps [--delete-data]] [--yes]
```

Removes Provelox. Run it on a Swarm manager. It shows the plan and changes nothing without `--yes`. It only touches
objects carrying Provelox's own label, never anything else on the server, and it never leaves the Swarm.

By default it leaves your apps running: it runs `detach`, then removes only the console and the API. The apps, the
proxy, the secrets and all data stay, and nothing restarts. Taking the apps down is a separate choice:

| Option          | Meaning                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_        | Run `detach`, then remove only the console and the API. Apps keep running.                                                                                                                                                 |
| `--remove-apps` | Also stop and remove the apps and the proxy, the platform's own secrets, configs and networks. **The apps are down until Provelox is installed again.** Volumes (databases, uploads, certificates) and apps' secrets stay. |
| `--delete-data` | With `--remove-apps` only: also delete the volumes and apps' secrets. This cannot be undone.                                                                                                                               |

See [Removing Provelox](/guide/removing-provelox).

## reset-password

Sets a new admin password. Run it with the platform's data volume mounted. It prints the password once and signs every
session out.

## migrate

```text
migrate --from <platform> --root-domain <domain> --api-url <url> [--image <name:tag>]
```

The whole migration as one guided, resumable run. See [Migration overview](/migration/overview).

| Option                   | Meaning                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `--from <platform>`      | The platform to leave. Optional while only one is supported.                                 |
| `--root-domain <domain>` | The domain apps are served at on Provelox, normally the one the old platform used.           |
| `--api-url <url>`        | This Provelox's API as reachable from where you run the command.                             |
| `--image <name:tag>`     | The Provelox image to install again at the end. Needed when not run with `docker run`.       |
| `--state-file <file>`    | Where progress is kept. Default `./provelox-migration.json`.                                 |
| `--log-file <file>`      | Where everything printed is also written, with the time. Default `./provelox-migration.log`. |
| `--backup-dir <dir>`     | Where the spec of everything that gets stopped is saved. Default `./cutover-backup`.         |
| `--helper-image <image>` | The image used for copying data. Default `busybox:latest`.                                   |
| `--acme-email <email>`   | Turns on HTTPS when Provelox takes ports 80 and 443.                                         |

Needs `PVX_ADMIN_PASSWORD` in the environment and the Docker socket.

Copying a large volume prints nothing for many minutes, so the run says every 15 seconds that it is still copying and for
how long. Run it inside `tmux` or `screen`: if your SSH connection drops, the command stops with it. Running the same
command again carries on from where it stopped (progress is in the state file, and an app left half-made is finished).
Everything printed is also in the log file, so you can read what happened after a dropped connection. The helper image
for copying (`busybox:latest` unless you pass `--helper-image`) is made available before anything is created, so a
registry that cannot be reached shows up at once and with nothing changed.

## inventory

```text
inventory --from <platform> [--json]
```

Prints what the old platform runs and what moves. Changes nothing. Environment variable values are never printed.

## import

```text
import --from <platform> [--only app,app] [--apply]
```

Previews the import. With `--apply`, creates the apps on Provelox and copies their data.

## cutover

```text
cutover --from <platform> [--apply]
```

Previews the cutover. With `--apply`, moves the apps with data or host ports over and stops the old platform's proxy.
Run `install` again afterwards with `--http-port 80 --https-port 443`.

## CapRover options

| Option                   | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `--captain-dir <dir>`    | CapRover's data folder, mounted read-only. Default `/captain`. |
| `--root-domain <domain>` | Also resolves `$$cap_root_domain` in environment variables.    |
