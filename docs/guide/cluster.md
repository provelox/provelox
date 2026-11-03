# Servers and clusters

Provelox runs on Docker Swarm, so one install can spread apps over several servers. **Settings → Infrastructure → Servers** lists every server, what runs on it, and lets you add, pause, drain, promote, demote and remove them.

## Add a server

1. On the manager, press **Add a server**. Pick **worker** (runs apps; what most servers should be) or **manager**.
2. On the new server, which needs Docker, run the command shown:

   ```bash
   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:<version> join \
     --token SWMTKN-1-… --manager 10.0.0.1:2377
   ```

   It checks that the new server can reach the manager, tells you which ports to open if it cannot, and joins. Add `--advertise-addr <ip>` if Docker picks the wrong address for the new server. The same page shows the plain `docker swarm join …` command if you prefer it.

No password or SSH key is shared with Provelox, and nothing in the console logs in to the other server. The token is what lets a server join: anyone who has it can add a machine to your cluster, so treat it like a password. **Make a new token** replaces it and the old one stops working. The tokens are shown only to a signed-in admin, never to an access token.

Open the ports listed under [Firewalls and security](#firewalls-and-security) between the servers, and only between them. The new server pulls your apps' images itself, so it must be able to reach their registries. For a private registry, the sign-in saved under Settings → Registries is passed along when an app is deployed, so a worker needs no `docker login` of its own.

### Addresses

The dialog asks for two addresses:

- **This server's address, as the new one reaches it.** It starts as the address Docker advertises for the manager, which may be a private one. Use a private address when the servers share a network (a cloud provider's private network, a VPN) and a public one when they do not. The port (2377) is added for you.
- **The new server's own address** (optional). Fill it in when the new server has more than one network address, so the others know which to use. It adds `--advertise-addr` to the command.

Provelox cannot reach into the new server before it joins, so it cannot test the ports for you. The dialog watches the cluster instead and tells you when the new server appears. If nothing appears after a minute it lists what to check.

## Firewalls and security

Provelox does not change the firewall of any server. These are the rules to set yourself.

**Between the servers, and only between them**, allow:

| Port | Used for |
| --- | --- |
| `2377/tcp` | cluster management (managers only) |
| `7946/tcp` and `7946/udp` | servers finding each other |
| `4789/udp` | traffic between apps on different servers |
| IP protocol `50` (ESP) | the encryption of that traffic |

With ufw, on each server, once per other server's address:

```bash
ufw allow from 203.0.113.20 to any port 2377 proto tcp
ufw allow from 203.0.113.20 to any port 7946
ufw allow from 203.0.113.20 to any port 4789 proto udp
ufw allow from 203.0.113.20 proto esp
```

In a cloud provider's firewall or security group, allow the same ports and protocol 50 from the other servers' addresses (or from their security group), not from `0.0.0.0/0`. Ports 80 and 443 stay open to everyone on the server that runs the proxy.

**Prefer a private network.** If your provider offers a private network between servers, or you run a VPN such as WireGuard or Tailscale, use those addresses for the cluster. Then none of these ports need to be reachable from the internet at all.

**The join token is the key.** Whoever has it and can reach port 2377 can add a machine to your cluster. Joined machines are authenticated with certificates after that. Make a new token once a server has joined; the console shows it only to a signed-in admin.

**Traffic between servers is encrypted.** The network Provelox puts apps on is created as an encrypted overlay, so what apps send each other between servers cannot be read in transit. It costs a little CPU. If your servers are on a private network you may not need it, but it is on by default.

**A joined server is trusted.** A machine that joins can be given work and sees what its apps see, such as their environment and secrets. Join only servers you control and keep patched. A manager can do more than a worker: it holds the cluster's state, so keep the number of managers small.

### An install from before the network was encrypted

Installs made before this change have a plain network, and the Servers page warns you once there are two or more servers. A single server is not affected, because its traffic never leaves the machine. To switch, on a manager, at a quiet moment:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/provelox/provelox:<version> encrypt-network
```

It takes every service off the network, recreates it encrypted, and puts each service back with its own aliases. Apps restart one at a time and are unreachable for a moment, and so are the console and API for a few seconds.

## Pause, drain, promote, remove

- **Pause**: the server keeps what it runs but takes no new work.
- **Drain**: its work is moved to other servers and it takes none, until you **Activate** it. Use it before maintenance.
- **Make a manager / a worker**: a manager holds the cluster's state and can run the platform's own services. Keep **one, three or five** managers: two are no safer than one. A cluster always needs a manager, and the server the API runs on cannot be demoted or removed from here.
- **Remove from cluster**: drain the worker, run `docker swarm leave` on it, and when it shows as **down** remove it here (Docker only removes a server that has left or is lost). Provelox refuses to remove a server that holds an app's data until you release that app (see below).

Each change says what will happen first, including which apps move.

## Where an app runs

An app's **Configuration → Where it runs** can be:

- any server (the default),
- workers only (keeps it off the managers that run the platform),
- managers only, or
- one server you choose.

An app with persistent data keeps its volume on one server. Once the cluster has more than one, it is held to the server it runs on, and the card says so. Moving it would leave its data behind, so Provelox refuses to place it elsewhere; move the data first. It is remembered by the server's id, not its name, so another server that takes the same name cannot take the app. If the server is gone or being replaced, **Release** on the card forgets where the data is (the data is not moved), after which you choose the app's server again. When Provelox cannot tell where an app's data is (it has no instance to learn that from), it says so on the Servers page and asks you to choose, instead of guessing. The platform's own services (API, console, proxy) run on a manager.

## Switching to an encrypted network

If the warning above appears, an earlier install made the network apps talk over without encryption. `encrypt-network` is safe to run again if it is interrupted: it notes each service's networks on the service itself before taking it off the network, so running it a second time finishes the job.

## Traffic

Provelox runs one proxy, on a manager, and it publishes ports 80 and 443 there. Point your DNS at that server. Apps on other servers are reached over the cluster's network, so nothing else needs a public address. Published ports (such as a DNS server's 53) go through Swarm's routing mesh and answer on every server.

## From the API

All of this is admin-only; no access token can reach it.

- `GET /v1/system/cluster`: servers, what runs on each, warnings
- `GET /v1/system/cluster/join`, `POST /v1/system/cluster/join/rotate`: join commands and tokens
- `PATCH /v1/system/cluster/nodes/:id` with `{ "availability": "drain" }` or `{ "role": "manager" }`
- `DELETE /v1/system/cluster/nodes/:id`
- `PATCH /v1/apps/:name` with `{ "placement": { "node": "dfw-2" } }`, `{ "role": "worker" }` or `null`
