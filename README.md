# Provelox

A self-hosted platform for running apps and Docker Compose projects on Docker Swarm: deploys, domains with automatic HTTPS,
databases from templates, logs, usage and notifications, behind a web console. Coming from CapRover? It can take over an existing install on the same
server: see [Migration](docs/migration/overview.md).

| Folder     | What it is                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`     | The control plane (NestJS): the HTTP API, the CLI (`install`, `migrate`, …) and Swarm/Traefik wiring. Start with [`api/DESIGN.md`](api/DESIGN.md). |
| `console/` | The web console (Next.js) and its end-to-end tests (Playwright).                                                                                   |
| `docs/`    | The documentation site (VitePress).                                                                                                                |

The marketing site lives in its own repository, `provelox-site`.

## Run it

The platform ships as one image holding the API and the console, published as `ghcr.io/provelox/provelox` for amd64 and
arm64. On a machine with Docker:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:latest install --root-domain example.com
```

To build the image yourself, run `docker build -t provelox:dev .` in this folder.

The [documentation](docs/) covers installing, DNS, migrating from CapRover and the API.

## Develop

Each folder is its own npm project; there is no workspace tooling to learn.

```bash
cd api     && npm ci && npm test            # API: unit and HTTP tests run against a fake Docker
cd console && npm ci && npm test            # console: unit tests; `npm run dev` serves it on :4300
cd docs    && npm ci && npm run dev         # documentation
```

See [`api/README.md`](api/README.md) and [`console/README.md`](console/README.md) for settings, the end-to-end tests and
the real-Docker test suites. CI (`.github/workflows/ci.yml`) runs the three projects and builds the image.

## How it is built

Parts of Provelox are written with AI assistance (Claude). Every change goes through the same tests and review as any
other, and contributors are welcome to use such tools under the same rule.

## License

Provelox is licensed under the [Apache License 2.0](LICENSE). Issues and ideas are welcome. Pull requests are
not being accepted yet: see [CONTRIBUTING.md](CONTRIBUTING.md). Copyright 2026 Floms, Inc.
