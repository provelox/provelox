# Introduction

::: warning Work in progress
These docs are being written alongside the platform. Expect gaps, and expect commands to change.
:::

Provelox deploys and manages apps on a Docker Swarm, routes traffic to them with automatic HTTPS, and understands
Docker Compose projects natively. Coming from CapRover? See [From CapRover](/migration/caprover).

It is made of three parts that ship as one image:

- **API** (`pvx-provelox`): the control plane. Keeps the desired state of every app and reconciles it with Docker.
- **Proxy** (`pvx-traefik`): routes hostnames to apps and gets certificates.
- **Console** (`pvx-console`): the web interface.

Everything Provelox creates carries the label `io.provelox.managed=true`, and it only ever changes resources that carry
it. Anything else on the host is invisible to it.
