# From CapRover

::: warning Work in progress
This page will be filled in as the CapRover source settles.
:::

## What is carried over

Image, container port, instance count, environment variables, domains, volumes (copied), published host ports, and
the `srv-captain--<app>` name other apps use to reach it. `$$cap_appname` and `$$cap_root_domain` in variables are
resolved.

## What stays behind

- Custom nginx configuration, pre-deploy functions, service update overrides and redirect domains are listed as
  *needs attention*.
- Apps built from source on the server have no registry image: push one first. They are skipped.
- Apps that mount a server directory are skipped: move them by hand.
- Force HTTPS and certificates: turn HTTPS on in Provelox once it holds port 80.

## Reading CapRover's data

Mount CapRover's data folder read-only and point `--captain-dir` at it (default `/captain`). The configuration is read
from `<dir>/data/config-captain.json`.

## Names

| What | CapRover | Provelox |
| --- | --- | --- |
| Swarm service | `srv-captain--<app>` | `pvx-<app>` |
| Name other apps use | `srv-captain--<app>` | `<app>` (imported apps also answer to the old name) |
| Volume | `captain--<volume>` | `pvx-<app>-<volume>` |
