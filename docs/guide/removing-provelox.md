# Removing Provelox

Provelox lives entirely inside Docker, so removing it means removing Docker objects. The image has two commands for it, `detach` and `uninstall`. Both run on a Swarm manager, show what they would do first, and change nothing until you add `--yes`. They only touch objects that carry Provelox's own label, so your own services, networks and volumes are never listed or removed, and they never leave the Swarm. Plain `uninstall` is the gentle one: it removes Provelox's own console and API and leaves your apps running. Taking the apps down too needs `--remove-apps`. This page covers the three cases people ask about, all tried on a test server (Docker 29 with Swarm).

Every command below is run from the image:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:latest <command>
```

It is written `pvx-remove <command>` for short in the rest of this page. To type it that way, define a shortcut in your shell once:

```bash
# bash or zsh
pvx-remove() { docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:latest "$@"; }
```

```fish
# fish
function pvx-remove; docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:latest $argv; end
```

Use the same image version you run (for example `ghcr.io/provelox/provelox:0.5.0`) so the command matches the platform. The shortcut lasts for that terminal window only.

## What Provelox owns

| Kind                | Names                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Its own services    | `pvx-provelox` (the API), `pvx-console`, `pvx-traefik` (the proxy)                                            |
| Your apps           | one Swarm service per app, `pvx-<app>`                                                                        |
| Networks            | `provelox-net`, and `pvx-net-<project>` for each project                                                      |
| Volumes             | `pvx-provelox-data` (its database), `pvx-traefik-certs` (certificates), and `pvx-<app>-…` for each app's data |
| Secrets and configs | `pvx-provelox-jwt`, `pvx-provelox-admin-password`, `pvx-console-session`, and two Swarm configs               |

Nothing is installed outside Docker. The only change to the host is that `install` starts a Swarm when the host has none.

List what is there before you remove anything:

```bash
docker service ls
docker network ls
docker volume ls
```

Everything Provelox made starts with `pvx-` or `provelox-`. Anything else is yours and is not touched by the steps below.

## Remove Provelox and leave the apps running

This is what `uninstall` does when you give it no other option, because it is the one that does not disturb your running apps. Use it when you want to stop running Provelox's own console and API while your apps carry on. Apps are ordinary Swarm services and the proxy reads their labels straight from Docker, so they can keep serving, but **not by simply removing the two services**.

```bash
pvx-remove uninstall            # shows the plan
pvx-remove uninstall --yes      # does it
```

It first runs `detach`, then removes only `pvx-console` and `pvx-provelox`. The proxy, the apps, the secrets and all data stay. On the test server an app kept answering, and was not restarted, after the console and API were gone.

::: warning Why `detach` is needed
Each app's route has an error-page step that points at a small service defined by the API's own labels. When the API goes, that service disappears, the proxy rejects every route that uses it, and the apps answer `404 page not found` even though they are running. (The proxy's log says: `the service "pvx_error_pages@swarm" does not exist`.) `detach` takes that step out of each route first. It only changes labels, so nothing restarts, and domains, HTTPS redirects and other settings are left as they were.
:::

`pvx-remove detach` on its own does just that, and is safe to run any time: the apps then no longer depend on the API for their routes. Installing Provelox again puts the step back.

Apps protected by _Sign in with…_ ask the API about every request. `detach` leaves them alone and names them, because taking their protection out would make them public. They refuse visitors once the API is gone, so turn that protection off first (in the app's _Networking_ tab) or accept that they stay down.

### What you give up

- **Managing apps:** no console, deploys, upgrades, rollbacks, scaling, or changes to domains and variables. Use `docker service update` by hand.
- **Provelox's error pages:** the page for an unknown address and the custom 502 to 504 pages are gone. Visitors see Traefik's plain "Bad Gateway" and "404 page not found".
- **Background work:** usage history, image update checks and certificate diagnosis stop. Certificates still renew, because Traefik does that itself.
- **The platform addresses** (`console.<root-domain>`, `api.<root-domain>`) stop answering.

## Remove everything, apps included

Taking the apps down too is a separate, explicit choice: add `--remove-apps`.

```bash
pvx-remove uninstall --remove-apps            # shows the plan
pvx-remove uninstall --remove-apps --yes      # does it
```

**Your apps stop** and answer nothing until you install Provelox again. See [Doing this on a production server](#doing-this-on-a-production-server) before running it on one.

This removes the apps, the console, the API and the proxy, their secrets and configs, and the networks. **Volumes are kept**: databases, uploads and certificates. Add `--delete-data` (only allowed with `--remove-apps`) to remove those too, together with the apps' secrets. That cannot be undone, so back up what you need first.

Before running it you may prefer to delete apps from the console (tick _Also delete data_ for those with storage), which removes each app's service, volumes and network together.

The Swarm itself is never left. If Provelox started it and nothing else on the host uses it, `docker swarm leave --force` removes it, by hand. If you also run your own Traefik or other stacks on this Swarm, do not.

If something is left behind (Docker will not remove a network while a container still uses it), the command says what and exits with an error. Run it again a minute later.

### Next to your own Traefik

Provelox brings its own Traefik (`pvx-traefik`), which publishes ports 80 and 443 on the host. If you run another Traefik, install Provelox on other ports (`--http-port`, `--https-port`, see [Install](/guide/install)). Removing Provelox only touches the `pvx-` and `provelox-` objects above, so your own Traefik, stacks and networks are not affected, unless you attached them to `provelox-net`.

## Where things live, and what each command changes

| What                                                                                                                                                                                                              | Where it lives                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Apps' settings, **environment variables**, domains, ports, deploy keys, projects' compose files, collections, access tokens, registry and sign-in settings, the admin password's hash, activity and usage history | Provelox's database, on the `pvx-provelox-data` volume. Variables are also in each running service's definition. |
| **App secrets** (_Secrets_ in an app)                                                                                                                                                                             | Only in Docker's secret store. Provelox keeps their names, never their values, and cannot read one back.         |
| Certificates                                                                                                                                                                                                      | The `pvx-traefik-certs` volume                                                                                   |
| Each app's own data                                                                                                                                                                                               | Its `pvx-<app>-…` volumes                                                                                        |
| The platform's own secrets (sign-in signing key, first admin password, console session key)                                                                                                                       | Docker secrets `pvx-provelox-jwt`, `pvx-provelox-admin-password`, `pvx-console-session`                          |

| Command                                 | Apps                                                       | Environment variables                            | App secrets                                   | Data volumes and certificates | Console, API, proxy                          |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------- | ----------------------------- | -------------------------------------------- |
| `detach`                                | Keep running, nothing restarts                             | Unchanged                                        | Unchanged                                     | Unchanged                     | Unchanged                                    |
| `uninstall`                             | Keep running, nothing restarts                             | Unchanged (still in the running services)        | Unchanged (still mounted in the running apps) | Unchanged                     | Console and API removed, proxy keeps running |
| `uninstall --remove-apps`               | Stop and are removed (their settings stay in the database) | Kept in the database, applied again by `install` | **Kept**: Docker still holds them             | Kept                          | All removed                                  |
| `uninstall --remove-apps --delete-data` | Stop and are removed                                       | **Lost** with the database                       | **Deleted**                                   | **Deleted**                   | All removed                                  |

After a reinstall over a kept database, apps come back with their settings, variables, domains and secrets (matched by name), and certificates stay valid. Signed-in sessions are not kept: everyone, you included, signs in again with the admin password you had, because the signing key is made again.

Also gone with `uninstall --remove-apps`: the networks (made again by `install`), the platform's own secrets (made again) and the placeholder pages. Images pulled onto the server stay in Docker's cache. Anything that is not Provelox's, such as your own services, networks and volumes, is never touched.

A secret is deleted only by `--delete-data`, or if you leave the Swarm yourself. Leaving the Swarm removes Docker's secret store, so those values are gone: write them down first if you may need them.

## Doing this on a production server

What happens to running apps, as seen on the test server (an app on a fixed tag, one with a volume, and one on a tag that was moved to a different image on purpose, the way `latest` moves):

| Step                                  | Result for the running apps                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `detach`                              | Nothing restarts. Only routing labels change.                                                                                                                                                                                              |
| `uninstall`                           | Nothing restarts. The apps kept answering the whole time.                                                                                                                                                                                  |
| Then `install` again (same version)   | Nothing restarts: the same containers kept running, and the moved tag was **not** pulled again, so they stayed on the image they were running.                                                                                             |
| `uninstall --remove-apps` (data kept) | **Every app stops** and the server answers nothing until you install again.                                                                                                                                                                |
| Then `install` again                  | Apps are created again from their saved settings and **pull their tag again**. An app on `latest`, or any tag that moved, can come back as a newer image. In the test, the app on the moved tag came back as a different image and failed. |

So for production:

- **Use plain `uninstall`.** It is the default because it is the only form that leaves apps running.
- **Use `uninstall --remove-apps` only in a maintenance window**, and pin every app to a version tag (`1.26-alpine`, `20261030-013846`) first, so what comes back is the image that was running. The command lists the apps that will stop and marks the ones on a tag that can move.
- **Install again with the same Provelox version** if you want nothing to restart. A newer Provelox applies every app again when it starts, and Docker restarts any app whose definition that changes (a new health check, say). Upgrade as a separate step, from the console, when you are ready for that.
- **Keep the database volume.** Without `pvx-provelox-data`, Provelox starts empty and knows nothing about the apps.
- **Before you start:** write down any app secret you may need again (Provelox cannot read them back), back up the data volumes you care about, and run each command without `--yes` first to read the plan.
- Try it on a copy first if you can. A throwaway server takes minutes to set up with [Install](/guide/install).

## Bring Provelox back

Run `install` again with the same root domain and the same image (add your other options, such as `--acme-email`, `--http-port`):

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/provelox/provelox:latest install --root-domain example.com --acme-email you@example.com
```

When it finds `pvx-provelox-data` it keeps it:

```
Found the data of an earlier install and kept it: sign in with the admin password you already had. Your apps are
re-created from it, with their settings and variables. An app secret Docker no longer holds (after leaving the Swarm,
or `uninstall --remove-apps --delete-data`) has to be set again.
```

On the test server the old admin password signed in again, an app came back with its environment variable and its secret, its error-page step was restored, and an app's data volume was untouched. This only works if you kept `pvx-provelox-data`. Without the data volume Provelox starts empty and knows nothing about the apps, which keep running as plain services but are no longer managed.

## By hand

On a version older than 0.5.0, or to see exactly what the commands do: list the objects (`docker service ls`, `docker network ls`, `docker volume ls`; everything Provelox made starts with `pvx-` or `provelox-`), remove the services (`docker service rm pvx-console pvx-provelox pvx-traefik pvx-<app> …`), then the secrets, configs and networks, and the volumes last. For the keep-the-apps case, first remove the error-page step from each app's routes: for every `traefik.http.routers.*.middlewares` label drop the entry named `<app>-errors`, and remove the `traefik.http.middlewares.<app>-errors.*` labels, with `docker service update --label-rm` and `--label-add`.
