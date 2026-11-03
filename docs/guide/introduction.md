# Introduction

::: warning Before 1.0
Provelox is still before its 1.0 release: commands and settings can change between releases, and some pages have gaps.
Found a problem, or something missing? [Open an issue on GitHub](https://github.com/provelox/provelox/issues).
:::

Provelox deploys and manages apps on a Docker Swarm, routes traffic to them with automatic HTTPS, and understands
Docker Compose projects natively. Coming from CapRover? See [From CapRover](/migration/caprover).

Provelox is open source, released under the [Apache License 2.0](https://github.com/provelox/provelox/blob/main/LICENSE).
The [source and the release notes](https://github.com/provelox/provelox) are on GitHub.

It is made of three parts that ship as one image:

- **API** (`pvx-provelox`): the control plane. Keeps the desired state of every app and reconciles it with Docker.
- **Proxy** (`pvx-traefik`): routes hostnames to apps and gets certificates.
- **Console** (`pvx-console`): the web interface.

Everything Provelox creates carries the label `io.provelox.managed=true`, and it only ever changes resources that carry
it. Anything else on the host is invisible to it.
