# Security

What Provelox protects, what each part trusts, how to run it safely, and what is known to be missing. It has had two
reviews of the whole platform (API, console, installer and pipeline); this page records the outcome.

## What is protected, and how

| Part | Protection |
| --- | --- |
| Sign-in | Admin password (bcrypt). Wrong passwords are counted per visitor (from the proxy's `X-Forwarded-For`) with a looser overall cap. |
| Access tokens | 256-bit secrets stored only as hashes, compared in constant time, at one of three levels: *read*, *operate*, *update*. A route with no level declared is closed to tokens. |
| Update check | At most every six hours the API asks GitHub for the project's latest release; GitHub sees the server's address and the name `provelox` with its release number, nothing else. It only reports: an update starts only when an admin presses the button, goes forward only, and only after the registry has been asked whether the image can be pulled. Turn it off under Settings → Updates or with `UPDATE_CHECK=false`. |
| Deploy keys | Per app. A key can roll its app to a new version of the image it runs; it cannot run a different image. |
| Secrets | App secrets are Docker secrets: write-only, never returned. Saved registry passwords and webhook addresses are sealed (AES-GCM). |
| Outgoing calls | Webhook and node addresses may not point at cloud-metadata or link-local addresses (checked on the name and on what it resolves to). A call that carries a token never follows a redirect. |
| Served pages | Error pages and the placeholder page are written by whoever may set them, and are sent with a policy that allows styling and images but no script. |
| Clusters | Cluster controls are admin-only. Joined servers are authenticated by Swarm; the network apps use between servers is encrypted. |
| Delivery | Release images carry build provenance and an SBOM. CI actions are pinned to commits and run with a read-only token. |

## What a token can do

- **Read**: status and usage, an app's version history, how an app is set up by name (never an environment value, a command or a path), the disk summary, and newer-image checks. No environment values, secrets or logs.
- **Operate**: also restart, start, stop, scale (1 to 20 instances), read logs and the names of the host's processes, ask the registries again, and deploy another version of the image an app already runs.
- **Update**: the fleet-management level, so the most powerful key to give out. It also updates the platform (forward only), clears unused images, sets the error pages, placeholder page, default address, Let's Encrypt email, notification webhooks and registry sign-ins, and applies blueprints. A blueprint can create an app that runs any image, and can change an app that was created from a blueprint while it holds no secrets, custom domains or host directories.

The answer to an action (restart, stop, deploy and so on) never carries an app's definition to a token: until 0.4.0 it did, including environment values (see the change log). Nothing a token can do includes changing the domain, an existing app's secrets, the admin password, or the cluster. Give each tool or script the level it needs and no more.

## Running it safely

- **Use HTTPS.** Pass `--acme-email` at install. Without it the console, API and tokens travel in clear text.
- **Pin a release** (`ghcr.io/provelox/provelox:0.2.23`, not `:latest`) and update from the console, which only goes forward.
- **Put a proxy in front of the console**, and leave `CONSOLE_TRUST_PROXY` at its default so wrong passwords are counted per visitor. If nothing sits in front, set it to `false`: the header is then the visitor's own.
- **Firewall the cluster ports** (2377/tcp, 7946/tcp and udp, 4789/udp, and IP protocol 50) to the other servers only. See [Servers and clusters](/guide/cluster#firewalls-and-security).
- **Treat a joined server as trusted.** It can be given work and sees what its apps see.
- **Keep the Docker socket in mind.** The API runs as root with the Docker socket, which is root on the host. Anything that can run code inside the API can take the server.

## Known limits

These are known and not yet fixed. They are tracked in the project's to-do list.

- The API runs as root with the Docker socket mounted, and apps share a network with it, so a compromised app can reach the API directly and forge the forwarded address that per-visitor limits rely on.
- Self-update pulls by tag, not by digest, and images are not signed.
- The API keeps a global limit on wrong passwords that someone could use to delay the owner signing in. Per-visitor limits sit in front of it, and `reset-password` is the recovery path.
- App environment variables are stored in plain text in the database and shown in the service spec; use secrets for anything sensitive.
- Operate tokens can read app logs, which sometimes contain secrets.
- Read tokens can see the addresses of the servers in a cluster.
- Signing out of the console does not revoke its API token; the session ends when it expires.
