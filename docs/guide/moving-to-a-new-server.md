# Moving to a new server

How to take your apps and their data from one Provelox server to another: because you are changing provider, outgrowing a machine, or a server can no longer be trusted. This page ties the pieces together; each step links to the page that has the detail.

**Read this first if the old server may be compromised.** If [Security checks](/guide/security-checks) reports a critical finding, or you have any other reason to think someone else controls the machine, do not clean it and carry on: build a new server and move to it, and treat everything that was on the old one as exposed (step 8). Data you take off a machine you no longer trust can carry whatever is wrong with it, so load it only into fresh volumes, never run anything from it, and load database dumps into a new, empty database before you rely on them.

## What moves, and how

| What | How |
| --- | --- |
| Your apps (images, settings, domains) | Redeploy from your compose files, images and settings on the new server. The data below does not carry the app definition |
| Data on Docker volumes | **Save a copy on the server** on the old one, `rsync` it across, **Restore from a file on the server** on the new one |
| Databases (PostgreSQL, MySQL, MariaDB) | **Save a backup on the server** on the old one (the app keeps running), `rsync` the dump across, **Restore → From a file on the server** on the new one. See [Backing up and restoring a database](/guide/database-backup). A file-level copy of the database's volume only works if it was stopped while it was copied |
| Secrets and passwords | Set again on the new server (they are not in the volume copies unless the app stores them in its data). Rotate them if the old server is not trusted |
| DNS | Point the domains at the new server last, once everything works (step 7) |

## Steps

1. **Snapshot the old server's disk** with your provider, before anything else. It is the way back if a step goes wrong, and, for a server you do not trust, the evidence of how it was reached.
2. **Install Provelox on the new server** ([Install](/guide/install)) and deploy each app so that its volumes exist and it has started once. Use the same app names: a restore goes to a volume of the app with that name. A volume that has never been created cannot be restored into.
3. **Take the data off the old server.** On the old server's console, open the app, then **Configuration → Storage**.
   - **A volume** (files, uploads): choose **Download**, then **Save a copy on the server**. The app is down for the copy only if you choose **Stop the app while copying**; the app then starts again by itself.
   - **A database** (PostgreSQL, MySQL, MariaDB): do not copy its files. Use the **Database** card and choose **Save a backup on the server**. The app keeps running, and the dump is consistent. Tick **Every database on the server** to take all of them.

   The dialog shows the file's path and a command to fetch it. The file only appears in the folder when it is complete: a copy or dump that fails leaves nothing behind.
4. **Move the files straight from the old server to the new one**, so they never pass through your laptop. On the **new** server:

   ```bash
   rsync -avP root@old-server:/var/lib/provelox/imports/shop-data-20261102-210509.tar.gz /var/lib/provelox/imports/
   rsync -avP root@old-server:/var/lib/provelox/imports/db-track-20261102-210509.dump /var/lib/provelox/imports/
   ```

   `rsync` carries on where it stopped if the connection drops: run the same command again. (If the servers cannot reach each other, fetch the file to your computer with the same command pointing at `./`, then push it to the new server's folder with `rsync -avP ./file root@new-server:/var/lib/provelox/imports/`.) Volume archives (`.tar.gz`) and database dumps (`.dump`, `.sql`, `.sql.gz`) share the folder, and each is only ever restored into its own kind.
5. **Restore on the new server.** Open the app on the new console, then **Configuration → Storage**.
   - **A volume:** **Restore → From a file on the server**, pick the archive, and choose **Only if the volume is empty** (or **Replace what is there**, which needs the app's name typed). The app is stopped while the files are written and starts again by itself. Owners and permissions are kept.
   - **A database:** in the **Database** card choose **Restore → From a file on the server**, pick the dump, and choose **Add to what is there** (into the new, empty database) or **Replace what is there** (the app's name typed). The app keeps running while the dump is loaded, and the restore stops at the first error and says what it was. Deploy the same image, or a newer one: a dump restores into a newer version, not an older one.
6. **Check the apps.** Open each one, look at its logs, and use it as a person would. For a database, run a query you know the answer to.
7. **Switch DNS** to the new server when you are satisfied, then wait for the old addresses to stop answering. Keep the old server (stopped) for a few days.
8. **Rotate secrets that were on the old server**, especially if it is not trusted: the Provelox administrator password and access tokens, deploy keys, registry logins, each app's own secrets and database passwords, and any cloud or DNS API keys. If a monitoring tool or another system holds an access token for the old server, revoke it.
9. **Clean up.** Delete the archives and dumps from both import folders (the trash button in the restore dialog, or `rm` on the server): they hold the data, secrets and password hashes included. Remove the old server when you are sure.

## Good to know

- **The browser is for small files.** A browser upload has to arrive within about a minute (the proxy's limit), so large data goes through the import folder and `rsync`. See [Restoring an app's data](/guide/restoring-data).
- **Only the machine Provelox runs on.** In a cluster, a volume is copied from, and restored on, the machine that holds it. Do each machine's volumes on that machine.
- **Plan the downtime.** An app with data is stopped while its volume is copied (if you chose the consistent copy) and again while it is restored. A stateless app has none of that: deploy it on the new server and switch DNS.
- **Server directories are not volumes.** A folder of the server mounted into an app (a bind mount) is not copied by any of this; copy it yourself with `rsync`.
- **Database dumps** are in [Backing up and restoring a database](/guide/database-backup). They work for PostgreSQL, MySQL and MariaDB. For MongoDB and Redis, which are not supported yet, copy the volume with the app stopped, or use the database's own tool (`mongodump`, `redis-cli --rdb`) inside its container with `docker exec` from a shell on the server.
