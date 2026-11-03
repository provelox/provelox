# Compose file for Provelox

The rules for writing a Compose file that Provelox accepts (Provelox 0.5.0-rc.7 and later). It is written so it can be handed to a person or a coding agent: follow it and the file passes the preview and deploys. The same file is also valid plain Docker Compose.

A project is one Compose file. Each service becomes an app named `<project>-<service>`. All services share one private network and reach each other by service name (`mysql:3306`). Paste the file into **New → Compose project**, fill in the variables, review the plan, deploy.

## Skeleton

```yaml
x-provelox: # optional: what the form needs to know about the variables
  variables:
    DB_PASSWORD: { secret: true, minLength: 16, label: Database password }

services:
  db:
    image: mysql:8.4 # always an image, never a build
    restart: unless-stopped
    environment:
      MYSQL_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
    volumes:
      - db-data:/var/lib/mysql # named volume only
  web:
    image: ${WEB_IMAGE:?WEB_IMAGE is required, e.g. ghcr.io/acme/web:1.4.0}
    depends_on: [db]
    x-provelox: # makes this service reachable from the internet
      expose: true
      port: 3000 # the port the container listens on

volumes:
  db-data:
```

## Rules (an error stops the deploy)

- **Every service has `image:`.** `build:` is refused. Push images to a registry first. An image reference is one token: no spaces, nothing after the tag.
- **Volumes are named and declared.** `- name:/path` with `name` listed under the top-level `volumes:`. Host paths (`./x`, `/x`, `~/x`) and `type: bind` are refused. Anonymous volumes (`- /path`) are ignored with a warning, so their data is lost. `tmpfs` is refused. External volumes and non-`local` drivers are refused.
- **A service with volumes runs one instance** (`replicas` is forced to 1) and cannot later gain or lose volumes: remove the project and deploy again.
- **Values go in `environment:`** (map or `KEY=value` list). `env_file:` is refused.
- **Ports.** `ports:` with a host port publishes it on the server: `"8080:80"`, optionally `/udp`. No ranges, no bind address other than `0.0.0.0`, and not the ports the platform uses (80, 443 and its own). A bare `"80"` only documents the port. Prefer `x-provelox` (below) for anything people open in a browser.
- **`depends_on`** sets start order only. The name must be a service in the file, and no cycles. `condition: service_healthy` is treated as "running", so a dependent service can start before the database is ready: make it retry (`restart: unless-stopped` and a client that exits and is restarted works).
- **Refused:** `privileged`, `cap_add`, `devices`, `network_mode`, `pid`, `ipc`, `userns_mode`, `security_opt`, `sysctls`, `extends`, `profiles`, `external_links`, `tmpfs`, and top-level `secrets` and `configs`.
- **Size and syntax.** Valid YAML, at most 256 KB.

## Accepted and used

`image`, `environment`, `command`, `entrypoint`, `ports`, `volumes`, `restart`, `healthcheck`, `depends_on`, `labels`, `working_dir`, `user`, `deploy.replicas`, `deploy.resources.limits.memory` and `.cpus`, `deploy.restart_policy`.

`command` and `entrypoint` can be a list (safest) or a string split like a shell for simple cases.

## Accepted but ignored (a warning, harmless)

`stop_grace_period`, `container_name`, `hostname`, `links`, `extra_hosts`, `dns`, `logging`, `stdin_open`, `tty`, `cap_drop`, `ulimits`, `platform`, `pull_policy`, `init`, `stop_signal`, `mem_limit`, `cpus`, `shm_size`, `read_only`, `expose`, custom top-level `networks`. Use `deploy.resources.limits` for memory and CPU. Any unknown key is ignored with a warning.

## Public addresses: `x-provelox` on a service

```yaml
x-provelox:
  expose: true # reachable from the internet through the proxy
  port: 3000 # container port the proxy forwards to (1 to 65535)
```

Without it a service is private to its project. This only marks the service as exposable: the domain (and HTTPS) is attached afterwards in the service's **Networking** tab.

## Variables

Anything that differs between deploys is a variable: `${NAME}`.

| Write               | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `${NAME}`           | The value entered in the form (empty, with a warning, if not given). |
| `${NAME:-fallback}` | `fallback` when empty.                                               |
| `${NAME:?message}`  | Required. The preview shows `message` when it is empty.              |
| `$$`                | A literal dollar sign.                                               |

Write a helpful `message`: it is what the person sees. Do not put `}` in it. A value is substituted as text, so put a variable inside a URL only when it is URL-safe (hex is).

### Declaring variables: top-level `x-provelox: variables:`

```yaml
x-provelox:
  variables:
    JWT_SECRET: { secret: true, minLength: 32, label: Sign-in secret }
    PII_KEY:
      secret: true
      minLength: 32
      description: Back it up. Losing it makes stored data unreadable.
```

| Field         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `secret`      | `true`: hidden in the form and generated for the person (`kind: secret` means the same).             |
| `minLength`   | Whole number 1 to 256. Generated values are at least this long (never under 32); shorter is refused. |
| `label`       | The form's field name (default: the variable name).                                                  |
| `description` | Hint under the field.                                                                                |
| `default`     | Starting value.                                                                                      |

Rules for the agent:

- **Declare every secret** (passwords, tokens, signing and encryption keys, API keys), and set `minLength` to what the application itself enforces: look in its code or start-up checks.
- Quote a description that contains a comma or colon when using `{ ... }` form, or use the block form above.
- Declaring is optional for the file to work, but without it only the names (`PASSWORD`, `SECRET`, `TOKEN`, `KEY`) and the words "at least N characters" or "openssl rand -hex N" in a `${NAME:?...}` message are used to guess, which is unreliable.
- Never put real secret values in the file. Variable values are not stored; the person re-enters them to update.

## Updating a project

To add a service or change one, open the project and choose **Edit the compose file** (or **Add**), paste the new file, and review. The same project keeps its name and its place in the Apps list. A new service becomes another app of that project, named `<project>-<service>`, on the project's private network. Nothing else about the existing services changes unless the file changes it.

- **Values are filled in for you.** Provelox reads each variable's value back from the running services (an `environment` entry, the `image`, or a word of the `command` that is exactly `${NAME}`), so you do not retype secrets. A variable that only appears inside a longer value (for example in a connection string) cannot be read back and stays empty, and so does a new one.
- **The review says what will happen to each service**: _new_, _unchanged_, _changes without restarting_ (an address, the number of instances), or _restarts_ with the reason: `image a:1 → a:2`, or the names of the environment variables that differ (never their values). Whether a restart interrupts the service is stated too: a service without a volume starts the new container before it stops the old one, and a service with a volume stops first, so it is briefly unavailable.
- **A secret that differs from what is running is flagged** on the service that uses it, so a mistyped key is noticed before it is deployed.
- **What the file cannot say is kept on a service that stays:** its domains, primary domain, HTTPS and redirect settings, password, sign-in, CDN settings, custom error pages, the machine it is held to, and the other names it answers to. Updating the file never resets them.
- **A service the file no longer has is removed**, and its volumes are kept (a renamed service is not "no longer there": see Renaming a service below). A service that had no volume cannot gain one later, and the reverse, without removing the project: the review says so.

### Renaming a service

Renaming a service in the file looks like one service removed and a new one added, because a service is known by its name. On its own that would remove the old app together with everything the file cannot say: its **domains and HTTPS settings, password, sign-in, CDN settings, deploy keys, usage history and pins**. Only the data survives, because a project's volumes belong to the project.

So when the review sees one service gone and one added that look like the same service (the only pair, or sharing an image or the same data mounts), it asks:

> `web` looks renamed to `site`: keep its domains, secrets, deploy keys and history (recommended)

- **Checked (the default):** the old app becomes the new one. Its addresses, primary domain, HTTPS and redirect settings, password, sign-in, CDN, deploy keys and history carry over, the data stays in the project's volumes (even if the volume is renamed in the file), and the old name stays as an alias on the project's network. A service without data starts beside the old one and the old one goes afterwards, so nothing is interrupted. A service with data stops first and is briefly unavailable; if the new one cannot start, the old one is put back.
- **Unchecked:** the old service is removed with its domains, deploy keys and history, and the new one starts as a new service without them. The data volumes are kept.
- **Not suggested:** when several services were removed and added and it is not clear which is which, nothing is suggested. A service cannot change between having data and not having it, so a rename that would is not offered.
- **Domains are not part of the compose file.** They are attached in the service's Networking tab and belong to the app, which is why a rename has to carry the app over instead of reading them from the file.

Through the API, a deploy or preview takes `renames`: `{"<new service>": "<old service>"}`; the preview returns `renameCandidates` (the suggestions) and `renaming` (what the given `renames` would do). The old service must be one of the project's and no longer in the file, and the new one must not exist yet.

Apps that already run can be moved into a project too, keeping their data and their addresses; see Guide → Group running apps.

## Healthchecks

```yaml
healthcheck:
  test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
  interval: 10s
  timeout: 5s
  retries: 10
  start_period: 30s
```

Durations are like `10s`, `1m30s`.

## Checklist before handing the file back

1. Every service has an `image` (with a `${..._IMAGE:?...}` variable if the tag changes per deploy), and no `build`, `env_file`, host path or refused key.
2. Every named volume used is declared at the bottom; data services have one.
3. Every service the browser needs has `x-provelox: { expose: true, port: N }` with the port the container really listens on. Databases are not exposed.
4. Every `${VAR}` that must be set uses `:?message`; optional ones use `:-default` (or `:-` for empty).
5. Every secret is declared under `x-provelox: variables:` with `secret: true` and the application's real `minLength`.
6. A service that needs another to be ready has `depends_on` and tolerates the other not being ready yet.
7. Comments say what each variable is and where to get the value.
8. Check it by pasting it into **New → Compose project**: the preview must show no errors. The API refuses a file with errors; warnings are listed.

## The Upti stack as an example

`apps/upti/deploy/provelox/docker-compose.yml` in the Upti repository follows these rules: MySQL (private, one volume), the API (exposed on 80), the payroll app, the employee portal and the marketing site (each exposed on 3000). Notes for generating or changing it:

- The API refuses to start in production unless `JWT_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY` and `PII_ENCRYPTION_KEY` are each at least 32 characters. All three are declared with `minLength: 32`.
- The images come from variables (`API_IMAGE`, `PAYROLL_IMAGE`, `PORTAL_IMAGE`, `SITE_IMAGE`), pasted as the bare reference with nothing after the tag.
- The web images have their API address built in (`NEXT_PUBLIC_*`), so it is set when the image is built, not in the compose file.
- MySQL uses `mysql_native_password`, and the API restarts until the database answers (see `depends_on` above).
- `stop_grace_period` is kept for plain Docker Compose and ignored, with a warning, by Provelox.
