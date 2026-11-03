# Security checks

Provelox can look for the signs that a server has been taken over. It does this on its own shortly after it starts and then every half hour, and you can run it from **Settings → Security checks → Check now**. The Apps page shows a red alert when something serious turns up.

It was written after a real server was found running a hidden cryptocurrency miner: a monitor showed the machine as overloaded, the console showed the apps nearly idle, and the tools on the machine itself could not show what was using the processor.

## What it looks at

**From what Provelox already knows**

- **Databases open to the internet.** An app that publishes a database port (PostgreSQL, MySQL, Redis, MongoDB, Elasticsearch and others) or whose image is a database. Docker opens a published port on every address of the server and past the machine's own firewall, so `ufw` does not stop it. This is a common way in.
- **Work nothing accounts for.** The share of the processor that is working, compared with what every app and platform service together uses. If the machine is at least 40% busy and the apps explain under a quarter of it, something Provelox does not run is using the rest.

**On the machine itself.** A short-lived helper container looks at the host's files and processes. It has no network, a read-only filesystem and a memory cap, and it can read the whole host filesystem only as read-only. It is given two extra permissions: to read files whatever their permissions (`DAC_READ_SEARCH`), and to see which program another process runs (`SYS_PTRACE`, needed for `/proc/<pid>/exe`). Only the script Provelox gives it runs, for about a second, and it writes nothing. It looks at:

- `/etc/ld.so.preload`: this file forces a library into every program. A normal server has none, and rootkits use it to hide files and processes from `ps` and `ls`.
- A second account with root's user id.
- Processes the kernel counts in its control groups that `/proc` does not list.
- Processes on the machine itself running from `/tmp`, `/dev/shm`, a folder starting with a dot (other than well-known tool folders such as `.vscode-server` or `.nvm`), or a file that has been deleted. Inside an app's container a dot folder is normal (a headless Chrome from Puppeteer lives in `~/.cache`), so only a program run from a temporary folder, or deleted while running, is reported there, as a warning that names the app.
- Scheduled jobs (cron) that run something from those places, or that match names used by known mining malware.
- Programs left in `/tmp`, `/dev/shm` and `/var/tmp`.
- SSH settings that allow password logins or root login with a password.
- Which keys may sign in as root (by fingerprint, so you can compare them with your own), and whether that list changed in the last week.
- How many failed sign-ins there were in the last day, and from where.
- Docker listening on the network without TLS.
- A process outside any container using most of a core.

Because the helper runs in its own container, with its own libraries, a rootkit on the host that changes what programs there see does not change what the helper sees.

It never reads a process's command line, the secret part of a key, or the content of any file other than the ones listed.

## What a finding means

Findings come in three levels.

- **Needs action now:** a sign that the machine may be controlled by someone else, or a service that should not be public. A monitoring tool that reads the summary can mark such an instance critical.
- **Worth fixing:** a setting that raises the risk, like allowing SSH passwords.
- **For your information:** facts to compare with what you expect, such as the list of keys.

## What it does not tell you

This looks for common signs and is **not exhaustive**. It does not prove that a machine is clean, and an attacker who knows these checks can avoid them. It cannot see malware that hides in the operating system itself or lives only in memory, flaws inside your apps, other machines of a cluster, or what happened before the check ran. Think of it as a smoke detector, not an inspection. Where it cannot look (for example, the helper cannot start), it says so and runs only the checks on apps.

It also looks at one machine: the one the API runs on. Other machines in a Swarm are not checked.

## If it finds the machine itself

A finding such as a preloaded library, hidden processes, or a scheduled job named after known malware means someone else has control of the machine. Removing the file does not remove what put it there. Do this instead:

1. Close the way in. In your provider's firewall, allow SSH from your own address only and close every published database port.
2. Take a snapshot of the disk, so there is something to investigate.
3. Copy the data off: dump the databases and copy the files you need.
4. Build a new server from a clean image and deploy again.
5. Replace every secret that was on the old one: the Provelox password and tokens, any monitoring token for it, deploy keys, registry logins, and each app's secrets.

See also [Security](/guide/security) for how Provelox protects itself.

## API

- `GET /v1/system/security`: the last scan (a new one if it is over a minute old). `?fresh=1` takes a new one, `?cached=1` only reads the last one and never starts a scan. Admin only.
- `GET /v1/system/summary` includes `security: {critical, warning, at}` from the last scan, for monitoring tools.
