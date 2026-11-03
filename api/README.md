# Provelox API

The control plane behind the Provelox console. It deploys and manages apps on a Docker Swarm, routes traffic to
them (Traefik, automatic HTTPS), and deploys Docker Compose projects natively.

Read [DESIGN.md](./DESIGN.md) first: principles, Docker naming contracts, API outline and the milestone plan.

Documentation lives in [docs/](../docs) (a [VitePress](https://vitepress.dev) site: `cd docs && npm install && npm run dev`).
It is a work in progress.

## Install

One image holds the whole platform: the API, the web console and the installer. Roles are picked by command
(`api` is the default, then `console`, `install`, `bootstrap`).

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock <image> install \
  --root-domain example.com --acme-email you@example.com
```

`install` starts a Docker Swarm if the host has none, then installs the API (`pvx-provelox`), the proxy
(`pvx-traefik`, started by the API) and the console (`pvx-console`) from that same image. It prints where to sign in
and the generated admin password, once. Without `--acme-email` everything is plain HTTP and it says so. Point a
wildcard DNS record (`*.example.com`) at the server so apps are reachable.

**Upgrade** by running the same command from a newer image: data and sessions are kept, and existing apps are
re-applied when the API starts. Use `--http-port` / `--https-port` when 80/443 are taken, `--advertise-addr` when the
machine has several addresses and Docker cannot pick one for a new Swarm.

A private registry (GitHub's, say) needs `docker login` on the server first.

**Lost the admin password?** Run this on the server with the platform's data volume mounted (no Docker socket needed):

```bash
docker run --rm -v pvx-provelox-data:/data <image> reset-password
```

It prints a new password once and signs every session out. It works while the platform runs. To choose the password
instead, set `PVX_NEW_PASSWORD`. It refuses a folder that holds no Provelox database, so a wrong mount never creates a
second, empty platform.

## Build the image

The image holds the API and the console. Build it from the repository root:

```bash
docker build -t provelox:dev .
```

`bootstrap` is the lower-level command (pick every image and host yourself); `install` is built on it.

## Migrating from another platform

`migrate` moves the apps of another platform (CapRover today) onto this Provelox, one confirmed stage at a time, and can
be run again to carry on where it stopped. The platforms it can leave are modules under `src/migrate/sources/`. See
[the migration overview](./docs/migration/overview.md) and [adding a source](./docs/migration/adding-a-source.md).

```bash
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v /captain:/captain:ro -e PVX_ADMIN_PASSWORD \
  <image> migrate --from caprover --root-domain example.com --api-url http://api.example.com:8080
```

## Naming and conventions

Everything Provelox creates in Docker has a predictable name and carries ownership labels. These names are a
compatibility contract (changing one orphans what already exists); the full table is in [DESIGN.md](./DESIGN.md).

Coming from CapRover:

| What                            | CapRover                    | Provelox                                               |
| ------------------------------- | --------------------------- | ------------------------------------------------------ |
| Swarm service                   | `srv-captain--<app>`        | `pvx-<app>`                                            |
| Container (named by Swarm)      | `srv-captain--<app>.1.<id>` | `pvx-<app>.1.<id>`                                     |
| Name other apps use to reach it | `srv-captain--<app>`        | `<app>`                                                |
| Shared network                  | `captain-overlay-network`   | `provelox-net`                                         |
| App data volume                 | `captain--<volume>`         | `pvx-<app>-<volume>`                                   |
| Ownership label                 | `com.caprover.managed`      | `io.provelox.managed=true` and `io.provelox.app=<app>` |

**Apps**

- An app named `myapi` is the Swarm service `pvx-myapi`. On the shared network `provelox-net` it answers to its plain
  name, so another app calls it as `http://myapi:3000`. There is no long prefix to remember.
- App names are lowercase letters, numbers and single dashes, at most 49 characters. `provelox`, `traefik`, `console`
  and `registry` are reserved for the platform.

**Compose projects and templates**

- Each service becomes an app named `<project>-<service>` (for example `rustfs-rustfs`, the service `pvx-rustfs-rustfs`),
  labelled `io.provelox.project=<project>`.
- The project gets a private network `pvx-net-<project>` where the Compose service names (`db`, `redis`, ...) work as
  aliases, so a Compose file's own connection strings keep working.
- Volumes are `pvx-<project>-<volume>` and are kept when the project is removed.
- A project's apps are removed with the project, not one by one.

**Secrets, configs and volumes**

- App secrets: `pvx-<app>-<name>-<hash>`, mounted as `/run/secrets/<name>`. Docker secrets cannot change in place, so a
  new value is a new secret (new hash) and the service switches to it. Values are never kept by Provelox. A rebuilt
  Swarm loses them: the app then shows a "cannot start" notice listing the missing ones, and they can be set again
  (or deleted) one at a time in the app's Secrets tab.
- The placeholder page (shown before an app's first deploy) is the config `pvx-placeholder-<hash>`.

**The platform itself**

| Part            | Name                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| API             | service `pvx-provelox`, secrets `pvx-provelox-jwt` and `pvx-provelox-admin-password`, volume `pvx-provelox-data` |
| Proxy (Traefik) | service `pvx-traefik`, volume `pvx-traefik-certs`                                                                |
| Console         | service `pvx-console`, secret `pvx-console-session`                                                              |

These are platform services, not apps: they never appear in the app list and cannot be stopped or deleted from the
console. They are installed and upgraded only by the `install` command (see above), which rolls them even when the
image tag is unchanged (a moving tag such as `latest`).

**Ownership is checked, not assumed.** Before changing or deleting anything, Provelox checks the resource carries
`io.provelox.managed=true` and the matching `io.provelox.app` (or project) label. Anything else on the host,
including a running CapRover, is invisible to it and never touched.

## Run from source

```bash
cp .env.example .env      # set JWT_SECRET; optionally ADMIN_PASSWORD
npm ci
npm run build && node --env-file=.env dist/main.js     # or: npm run dev
```

Needs a Docker Engine in Swarm mode (`docker swarm init`). All routes are under `/v1`, except `GET /health`.
Sign in with `POST /v1/auth/login {"password": "..."}` and send `Authorization: Bearer <token>`.

## Test

```bash
npm test               # unit + HTTP tests, no Docker needed (fake Docker)
npm run test:docker    # real Docker Swarm: creates pvxtest-* resources, removes them afterwards
```

The Docker suites never touch anything they did not create: every resource is named `pvxtest*` and labelled
`io.provelox.managed`. They are safe to run next to other Swarm services. `test/selfhost.docker.spec.ts` needs the
image: `docker build -t provelox-api:pvxtest .` first.

## What works today

- Auth (bcrypt password, JWT, brute-force slowdown, no default password), change password
- Apps: create / patch / delete, env, ports, volumes, instances, domains, HTTPS flags, deploy an image with
  rollout tracking, version history, reconcile
- Groups (folders)
- Compose projects: preview, deploy, redeploy (diff), remove; services reach each other by compose name
- Proxy: Traefik runs as a managed Swarm service; hostname routing, HTTPS via Let's Encrypt (set an email),
  force-HTTPS, custom domains, root domain with automatic re-routing
- Placeholder page (a Swarm config) and per-app custom error pages (502/503/504)
- Secrets (write-only, mounted under /run/secrets), private registries (encrypted credentials), CI deploy keys
  (scoped to one app) with a key-authenticated deploy endpoint
- Live logs (JSON or Server-Sent Events)
- Storage report and safe cleanup (re-checks ownership at delete time)
- Moving data from an image's unnamed volume into a named one: the original is held while the app stops, the copy is
  verified, and any failure restores the app and keeps the original held until you release it
- Self-install and in-place upgrade (`bootstrap`)

Not built yet (see DESIGN.md milestones): switching the console over from CapRover.
