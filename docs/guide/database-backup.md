# Backing up and restoring a database

A database is best saved as a **dump**: a file the database itself writes, that is consistent while the database keeps running, that can be loaded into a fresh server, and that survives a move to a newer version. Provelox runs the database's own tools inside the app's container, so you get a dump without stopping the app and without handing Provelox a password.

This works for **PostgreSQL**, **MySQL** and **MariaDB**. MongoDB and Redis are not supported yet; for those, use [Downloading data](/guide/downloading-data) (with the app stopped) or the database's own tool.

There are two ways to move a dump, as with a volume's data:

| | Through the server folder | Through the browser |
| --- | --- | --- |
| Back up | **Save a backup on the server** | **Download backup** |
| Restore | **Restore → From a file on the server** | **Restore → From my computer** |
| Best for | Anything large, and moving between servers | Small dumps |
| Size limit | None but the disk | About 200 MB warned, 2 GB refused, and an upload has to arrive in about a minute |
| If the connection drops | `rsync` carries on where it stopped | It starts again from the beginning |
| Passes through a browser | No | Yes |

## Back up

1. Open the app, then **Configuration → Storage**. A **Database** card appears under the volumes when Provelox recognises the database (see below for when it does not).
2. Choose how to take the dump:
   - **Download backup** sends the file to your browser in a new tab: `db-track-20261102-210509.dump` for PostgreSQL, `shop-20261102-210509.sql.gz` for MySQL and MariaDB.
   - **Save a backup on the server** writes the same file into the server's import folder instead (see [The import folder](#the-import-folder)), with no size limit and nothing going through the browser. The dialog then shows the file's path and a ready-to-copy `rsync` command to fetch it.
3. Tick **Every database on the server** to dump all of them instead of only the app's own (`pg_dumpall` for PostgreSQL, `--all-databases` for MySQL and MariaDB). A PostgreSQL dump of everything is plain SQL, gzipped.

The app keeps running. A dump that stops half way (the tool crashes, the container restarts, the disk fills up) never looks complete: a download is cut off, and a saved backup is written under a hidden name and only moved into the folder, where it can be listed and restored, once the tool has finished successfully. A failed dump leaves no file behind.

## Restore

Choose **Restore** in the same card, then where the dump is:

- **From a file on the server** (recommended for large dumps). See below.
- **From my computer** for a small one: pick a PostgreSQL `.dump`, or SQL text, plain or gzipped (`.sql`, `.sql.gz`). A progress bar shows the upload; **Cancel upload** stops it, and the restore with it. The dialog warns above 200 MB and does not offer an upload above 2 GB.

Either way, choose how:

- **Add to what is there** applies the dump on top of the database. It stops at the first thing that clashes with what already exists (a table that is already there, say) and shows what that was. Rows restored before that point stay.
- **Replace what is there** drops everything in the database first, then restores the dump. This cannot be undone: download or save a backup first (the dialog links to it). You must type the app's name to confirm.

The app keeps running while data is restored or replaced, so its connections may see errors in that time. Provelox looks at the file before it starts: a dump made by another kind of database is refused (a PostgreSQL dump into MySQL, or the reverse) and nothing is touched.

### From a file on the server

A browser upload has to arrive within about a minute, because the proxy in front of the console cuts a request that takes longer to arrive. A large dump should not go that way. Put it in the **import folder** instead and restore from there:

1. Put the dump in the folder on the server, with `rsync` or `scp`. Choose **Restore → From a file on the server**: the dialog shows the folder's path and the command to copy, like

   ```bash
   rsync -avP ./shop.dump root@your-server:/var/lib/provelox/imports/
   ```

   `rsync` carries on where it stopped if the connection drops (run the same command again); `scp` does not. Use the server's real address if the console's is different.
2. Choose **Refresh**. The dumps in the folder appear with their size and age. Only dumps are listed here (`.dump`, `.sql`, `.sql.gz`), never the volume archives that may be in the same folder.
3. Pick one, choose **Add** or **Replace**, then **Restore**.

Nothing is uploaded through the browser, so the dump can be as large as the disk, and the restore carries on at the server if you close the page. Before anything is changed, Provelox reads the first bytes of the file to see what it is: a dump of another kind of database is refused with the database untouched. The restore stops at the first error, and says what it was.

## The import folder

The import folder is one fixed folder on the server, `/var/lib/provelox/imports/` by default (set `IMPORTS_DIR` on the Provelox API to use another absolute path; see [Restoring an app's data](/guide/restoring-data#the-import-folder) for how the folder is created and kept private). Volume archives and database dumps share it, and each is kept to its own use:

| Ends in | Is | Used by |
| --- | --- | --- |
| `.tar.gz`, `.tgz` | a volume archive | volume restore only |
| `.dump` | a PostgreSQL custom-format dump | database restore only |
| `.sql`, `.sql.gz` | SQL text, plain or gzipped | database restore only |

A dump can never be unpacked into a volume, and an archive is never given to a database tool: each restore refuses the other kind by its name before anything is read. The same safety rules apply to dumps as to archives: a file is only ever named, never given as a path (a name with a slash or `..` is refused); links, folders and hidden files are never listed; the folder is mounted read-only for a restore; and only administrators can list it, restore from it, save into it or delete from it. Each is recorded in the activity log with who did it and which file, never what was in it.

Delete a dump when you are done with it (the trash button in the restore dialog, or `rm` on the server): it holds the data as it is, passwords included.

## Moving to another server

Save a backup on the old server, `rsync` it into the new server's import folder, deploy the same image on the new one (or a newer version), and restore the dump into the empty database. This is the safe way to leave a machine you no longer trust: a dump holds the data, not the files an attacker may have changed. [Moving to a new server](/guide/moving-to-a-new-server) has the whole job, step by step.

## From the API

```bash
# a dump saved into the import folder (?all=1 for every database); answers {file, sizeBytes, dir}
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/apps/db-track/database/export"

# restore from a dump that is in the folder (no body); clean=1 replaces, and confirm is the app's name
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/apps/db-track/database/restore?from=db-track-20261102-210509.dump"
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/apps/db-track/database/restore?from=db-track-20261102-210509.dump&clean=1&confirm=db-track"

# a dump as the body instead (small files), and a dump as a download
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/octet-stream" --data-binary @db-track.dump \
  "https://api.example.com/v1/apps/db-track/database/restore"
curl -fS -H "Authorization: Bearer $ADMIN_TOKEN" -o db-track.dump \
  "https://api.example.com/v1/apps/db-track/database/dump"
```

`GET /v1/system/imports` lists the folder; each file has a `kind` (`volume` or `database`) that says what it is for. A restore from the folder answers `{"restored": true, "file": "db-track-20261102-210509.dump", "bytes": 1234}`. A name that is not a dump file name (including a volume archive) answers 400, a file the folder does not hold 404, a body together with `from` 400, replacing without the app's name 400, a dump of another engine 400, a restore that failed 422, and an access token 403.

## What you should know

- **A dump from an older server restores into a newer one, not the other way round.** PostgreSQL 9.6 into PostgreSQL 16 works; PostgreSQL 16 into 9.6 usually does not. The same goes for MySQL and MariaDB. MySQL and MariaDB read each other's plain SQL, but features can differ.
- **Replacing is destructive.** For PostgreSQL it drops every schema of the database (except the server's own) and makes `public` again, then restores. For MySQL and MariaDB it drops and re-creates the database. Roles and users are not part of a one-database dump and are not touched.
- **Ownership and permissions are not restored for PostgreSQL** (`--no-owner --no-acl`): everything belongs to the app's own database user, because a dump from another server names roles that may not exist here.
- **Credentials stay in the container.** The tools read the app's own settings from the container (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `MYSQL_ROOT_PASSWORD` and so on, or the same names with `_FILE`). Provelox never reads, shows or logs them, and they are not on any command line.
- **The dump holds the data as it is**, personal data and password hashes included. Keep the file as safe as the server and delete it when you are done.
- **A file that cannot be read to the end is reported.** When restoring from the folder, the file is read by a helper and streamed into the tool. If the file stops being readable half way, the restore answers with an error saying the database may be only partly restored, instead of looking like a short dump that succeeded.
- **Disk space.** Saving a backup needs room for the whole dump in the folder. If the disk fills up, the dump is not kept and nothing half-written is left in the folder.
- **Only administrators.** An access token, even an `update` one, is refused. Each backup and restore is recorded in the activity log with who did it, never what was in it.
- **Only apps on the machine Provelox runs on**, and only while they run (the tools run inside the container).

## When the card does not appear

Provelox asks the container which tools it has, so it needs the app to be running and its image to contain the database's tools (`pg_dump`, `pg_restore`, `psql`, or `mysqldump` and `mysql`, or the `mariadb-` names). A custom image named like a database but without them shows the card with the reason. An app that does not look like a database at all shows no card.
