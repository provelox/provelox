# Install

One image holds the whole platform: the API, the web console and the installer. It is published on GitHub's container
registry:

```
ghcr.io/provelox/provelox
```

It is built for both `linux/amd64` and `linux/arm64`, so the same name works on an Intel server and an ARM one.

## What you need

- A Linux server (a VPS or a machine of your own, Intel or ARM) with **Docker Engine** installed. You do
  not need to set up Swarm yourself: the installer starts one when the host has none.
- Ports **80** and **443** free, or pick others with `--http-port` and `--https-port`.
- A domain you control, with a wildcard DNS record (`*.example.com`) pointing at the server, so each app gets an address
  like `shop.example.com`.
- Root access (or a user that can run `docker`), since Provelox manages Docker through its socket.

## Install Docker

Skip this if `docker version` already prints a Server section.

On a Linux server, Docker's own convenience script installs the Engine for your distribution:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
less get-docker.sh   # read it first: it runs as root
sudo sh get-docker.sh
```

Or follow Docker's [step-by-step instructions](https://docs.docker.com/engine/install/) for Ubuntu, Debian, Fedora,
CentOS and others to use your package manager directly. Then check it:

```bash
sudo docker run --rm hello-world
sudo docker version
```

On a Mac or Windows PC, install [Docker Desktop](https://docs.docker.com/desktop/) instead. That is fine for trying
Provelox on your own machine (use a root domain like `provelox.localhost`), but run a server install on Linux.

::: warning Firewall
Open ports 80 and 443 (and nothing else is needed for a single server). If you later join more servers to the Swarm,
those also need 2377/tcp, 7946/tcp and udp, 4789/udp and IP protocol 50 (ESP) between them, and only between them. See [Servers and clusters](/guide/cluster).
:::

## Install Provelox

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:latest install \
  --root-domain example.com --acme-email you@example.com
```

`install` starts a Docker Swarm if the host has none, then installs the API, the proxy and the console from that same
image. It prints where to sign in and the generated admin password, once. Without `--acme-email` everything is plain
HTTP and it says so.

Point a wildcard DNS record (`*.example.com`) at the server so apps are reachable.

With `--acme-email`, certificates are requested from Let's Encrypt the first time a site is visited, and that can take
up to a minute. Until then the proxy shows a placeholder certificate, so a browser opened right after the install
warns that the connection is not private. Wait a moment and reload. If it lasts longer, the domain does not point at
the server yet or port 80 is not reachable from the internet.

### From a private image

If the image is private (for example a private package on GitHub), sign in on the server first, so Docker can pull
it for the installer, then pass the same credentials to `install`:

```bash
docker login ghcr.io -u <user>          # a token that can read packages
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -e PVX_REGISTRY_PASSWORD='<token>' \
  ghcr.io/provelox/provelox:latest install \
  --root-domain example.com --acme-email you@example.com --registry-user <user>
```

`install` checks the credentials before it changes anything, and hands them to Docker Swarm so every machine in the
cluster can pull the image. Pass them again when you upgrade by hand, since an install without them replaces the service's sign-in. From 0.2.12 the API also adds them to **Settings → Registries** when it starts (never replacing an entry that is already there), which is where an update from the Provelox Hub looks. The password is read from
the environment, never from the command line, so it stays out of your shell history and the process list.

### Next to CapRover, Dokploy or another platform

Provelox can share a server with another platform while you move apps over. Two things have to differ: the ports and
the root domain.

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/provelox/provelox:latest install \
  --root-domain pvx.example.com --http-port 8080 --https-port 8443
```

- **Ports.** CapRover and Dokploy keep ports 80 and 443 for their own proxy, and both also use 3000. Give Provelox
  others with `--http-port` and `--https-port`, and open them in the firewall. Provelox does not use 3000.
- **Root domain.** Use one the other platform does not own, with its own wildcard record (`*.pvx.example.com`). If you
  reuse its domain, that platform's wildcard record sends Provelox's hostnames to the wrong place.
- **Where things are.** The console is at `http://console.pvx.example.com:8080` and each app on the same port, for
  example `http://myapp.pvx.example.com:8080`. Sign in with the password `install` prints once.
- **Swarm.** CapRover runs on Docker Swarm. `install` only starts a Swarm when the host has none, so it joins the
  existing one and adds its own `pvx-*` services beside the other platform's. They use separate networks and volumes
  and Provelox does not touch the other platform's services, but they share one Swarm, so leaving the Swarm or removing
  a node affects both.

::: warning HTTPS needs ports 80 and 443
Certificates from Let's Encrypt are checked on ports 80 and 443, so do not pass `--acme-email` on other ports: you get
plain HTTP, and the installer says so. For real certificates, either move the other platform off 80 and 443, or put one
proxy in front of both and forward each platform's hostnames to it.
:::

## Versions and compatibility

### Image tags

| Tag            | What it is                                                                |
| -------------- | ------------------------------------------------------------------------- |
| `latest`       | The newest release (a tag like `v0.2.0`). Pre-releases never move it.     |
| `0.2.0`        | Exactly that release. It never changes.                                   |
| `0.2`          | The newest `0.2.x` release: patch fixes, nothing larger.                  |
| `sha-<commit>` | The commit a release was built from.                                      |

For a server you care about, **pin an exact version** (`ghcr.io/provelox/provelox:0.2.0`) and move up on purpose. `latest`
is convenient for a first try, but an install or upgrade run with it picks up whatever is newest at that moment.

### Upgrading

Run the install command again with the newer tag. Data, sessions and your apps are kept, and the apps are re-applied
when the API starts. Use `--http-port` and `--https-port` if ports 80 and 443 are taken. A newer version can update the stored data, so
an older one may not read it back: copy the data volume first (below) if you might want to return.

::: warning Before 1.0
Provelox is at version 0.x: the API, the settings it stores and the command line can still change between minor versions
(`0.2` to `0.3`). Look through the changes before moving up a minor version, and copy the data volume
(`pvx-provelox-data`) first, for example with `docker run --rm -v pvx-provelox-data:/data -v "$PWD":/backup busybox tar czf /backup/provelox-data.tgz -C /data .`. Patch releases (`0.2.0` to `0.2.1`) are fixes only.
:::

### What it runs on

| Part          | Supported                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------- |
| CPU           | `linux/amd64` and `linux/arm64`                                                                 |
| Docker Engine | Developed and tested with Docker Engine 29. Swarm mode is required. Older engines are untested. |
| Proxy         | Traefik v3, installed by Provelox (`--traefik-image` to choose another)                         |

The images **you deploy** must be built for the CPU of the server they run on. An `amd64`-only image on an `arm64`
server is refused by Docker, and Provelox says so on the failed deploy. Publish multi-platform images
(`docker buildx build --platform linux/amd64,linux/arm64`) if you use both kinds of machine.

## Lost the admin password

```bash
docker run --rm -v pvx-provelox-data:/data ghcr.io/provelox/provelox:latest reset-password
```

It prints a new password once and signs every session out.

::: tip
See the [command line reference](/reference/cli) for every option.
:::

## Serve the console and API over HTTPS later

If the platform was installed without `--acme-email` (or moved here from another platform), the console and API answer on plain HTTP. You do not need to run the install command again: under **Settings → General → HTTPS certificates**, save a Let's Encrypt email, then press **Serve the console and API over HTTPS**. The addresses must already point to this server, with ports 80 and 443 reachable; the certificate can take up to a minute to appear. Plain HTTP is then redirected, and you sign in again at the HTTPS address.

## Give apps a domain of their own

By default apps share the root domain: with `lax1.nodes.example.com`, an app `app-1` is at `app-1.lax1.nodes.example.com`. To keep the root domain for the console and API only, set **Domain for apps** under **Settings → General** (say `app.example.com`). Then `app-1` is at `app-1.app.example.com`, and the console and API stay where they are.

Add a wildcard record `*.app.example.com` pointing at the server first. Existing apps move to their new address and their certificates are requested again, one per address as for any domain. **Use the root domain** goes back. The hub shows each node's apps domain and uses it for the address it lists for every app.

## Pin the release

`:latest` is a moving name. To install exactly one release, use its number instead (`ghcr.io/provelox/provelox:0.2.23`). Every release image carries build provenance and a software bill of materials. You can inspect them with:

```bash
docker buildx imagetools inspect ghcr.io/provelox/provelox:0.2.23 --format '{{ json .Provenance }}'
```

Updating from the console moves to a release number and refuses an older one.

Docker Swarm's management port (2377/tcp) listens on every address of a manager. On a server with a public address, close it (and 7946 and 4789) in the firewall unless other machines need to join.

## Change the root domain

Under **Settings → General**, choose **Change domain**. Every app moves to `<app>.<new domain>`, and so do the console and the API (`console.<new domain>` and `api.<new domain>`).

Add the DNS records first: a wildcard `*.<new domain>` pointing at this server covers all three. Provelox moves the console and API only once their new names resolve. Until then the console stays at its current address and the page tells you what is missing; save the domain again after adding the records.

When the console moves, you get a link to its new address. Sign in again there (a session belongs to one address). Its HTTPS certificate can take up to a minute to appear. A console or API address you gave by hand at install (`--console-host`, `--api-host`) is never changed.
