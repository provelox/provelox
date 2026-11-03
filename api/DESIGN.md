# Provelox API: design

The control plane behind the Provelox console. It deploys and manages apps on a Docker
Swarm, routes traffic to them with automatic HTTPS, and understands Docker Compose projects natively.

## Principles

- **Small control layer over Docker Swarm.** Optimise the common deployment workflow, do not mirror every Docker
  feature. Docker is the source of truth for what is *running*; this service is the source of truth for what
  *should* run (the desired state) and reconciles the two.
- **Ownership is explicit.** Everything this service creates carries `io.provelox.managed=true`. It only ever
  changes or deletes resources that carry that label *and* belong to the exact app/project in question. Anything
  else on the host (including a running CapRover) is invisible to it. Ownership uncertain: do nothing and log.
- **Compose semantics are real.** A Compose project gets its own overlay network and every service keeps its Compose
  name as a network alias, so `db:5432` just works. No hostname rewriting.
- **Boring, swappable parts.** NestJS (like the rest of the monorepo), SQLite for state, Traefik for routing and
  Let's Encrypt, dockerode for Docker. State access sits behind repositories so the store can change.

## Architecture

```
console ──HTTPS──▶ API (NestJS)   ──▶ Docker Engine (Swarm)
                        │                         ▲
                        ├── SQLite (desired state)│
                        └── Traefik labels ───────┘  Traefik reads service labels: routing, TLS, redirects
```

- `apps`: app definitions → a Swarm service each (`pvx-<app>`), reconciled from the definition by a pure
  function (`buildServiceSpec`), so the mapping is unit-testable without Docker.
- `projects` (Compose): a pure translator turns a compose file into app definitions + volumes + network, with
  explicit errors/warnings for anything unsupported; a project then deploys as a group of apps.
- `proxy`: Traefik runs as a Swarm service this API manages. Domains, HTTPS, force-HTTPS, websockets, custom error
  pages and the placeholder page are all expressed as labels/middlewares generated from the app definition.
- `auth`: one admin password (bcrypt) → JWT; per-app CI keys (hashed, scoped to deploy one app).
- `storage`: read-only classification of volumes/images, deletion only with ownership proof (ported from CapRover's
  StorageClassifier rules).

## Docker naming (compatibility contract, do not change lightly)

| Thing | Name / label |
| --- | --- |
| App service | `pvx-<app>`, labels `io.provelox.managed=true`, `io.provelox.app=<app>` |
| Compose project service | `pvx-<project>-<service>`, plus `io.provelox.project=<project>` |
| Shared network | `provelox-net` (overlay, attachable): apps reach each other as `<app>` |
| Project network | `pvx-net-<project>`: Compose service names are aliases |
| Managed volume | `pvx-<app>-<name>` / `pvx-<project>-<name>`, `io.provelox.managed=true` |
| Secret | `pvx-<app>-<name>-<hash>`, same labels |

## API (v1, REST/JSON, bearer JWT)

Parity with what the console does today, in its own shapes (no CapRover envelope):

- `POST /v1/auth/login`, `POST /v1/auth/change-password`, `GET /v1/auth/status`
- `GET/POST /v1/apps`, `GET/PATCH/DELETE /v1/apps/:name`
- `POST /v1/apps/:name/deploy` (image), `GET /v1/apps/:name/builds/current`, `GET /v1/apps/:name/logs` (SSE)
- `PUT /v1/apps/:name/env`, ports, volumes, secrets, domains, error pages (part of the app document)
- `GET/POST/PATCH/DELETE /v1/groups`
- `GET/POST/PATCH/DELETE /v1/registries`
- `POST /v1/projects/preview` (compose → plan, no changes), `POST /v1/projects` (deploy),
  `GET/PUT/DELETE /v1/projects/:name`
- `GET/POST/DELETE /v1/ci-keys`, `POST /v1/ci/deploy` (key-authenticated)
- `GET /v1/system/info`, `GET/POST /v1/system/domain`, `GET/POST /v1/system/placeholder-page`
- `GET /v1/system/storage`, `POST /v1/system/storage/{volumes,images}/delete`

## Compose support (v1 scope)

Supported: `image`, `environment`, `command`, `entrypoint`, `ports`, `volumes` (named), `restart`,
`deploy.replicas`, `deploy.resources` (limits), `healthcheck`, `depends_on` (start order), `networks` (project
network only), `labels` (kept as metadata), `working_dir`, `user`.

Rejected with a clear message (never silently ignored when it changes behaviour): `build` (no image to run),
host bind mounts (host filesystem access), `privileged`, `cap_add`, `devices`, `network_mode`, `pid`, `ipc`,
`extends`, `profiles`. `env_file` is rejected unless the contents are provided with the request.

## Milestones

1. **M0/M1 (this foundation)**: config, SQLite, auth, apps CRUD, Swarm reconcile, image deploy with build status,
   compose translator + preview, Docker integration tests (namespaced, self-cleaning).
2. **M2 (done)**: Traefik management, domains, HTTPS, error/placeholder pages.
3. **M3 (done)**: secrets, registries, groups, CI keys.
4. **M4 (done)**: project deploy/update/remove end to end (network, volumes, ordering).
5. **M5 (done)**: storage report/cleanup, log streaming, volume migration, self-install/upgrade (bootstrap).
6. M6: switch the console from CapRover to this API; retire the BFF where possible.

## Switching the console over (M6)

The console talks to CapRover through one module, the console's `src/lib/caprover.ts` (long since replaced) (plus its server actions). The
switch is a replacement of that module and the actions behind it, not a rewrite of the pages. Mapping:

| Console needs | CapRover call | This API |
| --- | --- | --- |
| Sign in / password | `POST login`, `POST user/changepassword`, `GET user/passwordstatus` | `POST /v1/auth/login`, `POST /v1/auth/change-password` (there is no default password, so no "default password" banner) |
| App list and detail | `GET user/apps/appDefinitions` | `GET /v1/apps`, `GET /v1/apps/:name` (status and hosts included) |
| Create / delete | `appDefinitions/register`, `/delete` | `POST /v1/apps`, `DELETE /v1/apps/:name` |
| Edit (ports, env, instances, domains...) | `appDefinitions/update` | `PATCH /v1/apps/:name` |
| Deploy an image, build status | `appData/:app?detached=1` | `POST /v1/apps/:name/deploy`, `GET .../deployment` |
| Logs | `appData/:app/logs/stream` | `GET /v1/apps/:name/logs?follow=1` (SSE) |
| Secrets | `appDefinitions/secrets` | `PUT/DELETE /v1/apps/:name/secrets/:secret` |
| Error pages / placeholder | `customerrorpages`, `system/placeholderpage` | `PATCH` with `errorPages`, `PUT /v1/system/placeholder-page` |
| Volumes and the move | `volumes`, `volumes/migrate` | `GET .../volumes/detected`, `POST .../volumes/migrate`, `GET .../volumes/migration`, `POST .../volumes/migration/release` |
| Root domain / HTTPS | `system/changerootdomain`, `enablessl`, `forcessl` | `PUT /v1/system/domain`, `PUT /v1/system/acme-email`, app fields `defaultSubdomainSsl` / `forceSsl` / `domains[].ssl` |
| Registries | `registries/*` | `GET/POST/PATCH/DELETE /v1/registries` (no push registry: nothing builds here) |
| Storage cleanup | `system/storage/*` | `GET /v1/system/storage`, `POST .../volumes/delete`, `POST .../images/delete` |
| CI keys | BFF-only (`api-keys.json`) | `GET/POST/DELETE /v1/ci-keys`, `POST /v1/ci/deploy`: the BFF's key store and `/api/ci/deploy` go away |
| Groups | BFF-only (`groups.json`) | `GET/POST/PATCH/DELETE /v1/groups`: the BFF's group store goes away |
| Compose | new | `POST /v1/projects/preview`, `POST /v1/projects`, `PUT/DELETE /v1/projects/:name` |

Differences the console must absorb: no response envelope (errors are `{ error: { code, message, details? } }`);
the API token replaces the CapRover token in the session cookie; the app model is the one in `app.model.ts` (for
example `env` instead of `envVars`, `domains` instead of `customDomain`, `containerPort` instead of
`containerHttpPort`). Existing CapRover apps are not migrated: they stay on CapRover until redeployed here.
