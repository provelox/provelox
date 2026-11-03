# Restoring an app's data

The way back from [Downloading an app's data](/guide/downloading-data): put a `.tar.gz` into one of the app's volumes. Use it to move data onto a rebuilt or new server, or to go back to a copy you took earlier. For the whole job of moving to another server, see [Moving to a new server](/guide/moving-to-a-new-server).

There are two ways to get the file to Provelox:

| | From a file on the server | From my computer |
| --- | --- | --- |
| Best for | Anything large (big volumes and big uploads) | Small files |
| Size limit | None but the disk | About 200 MB warned, 2 GB refused, and it has to arrive in about a minute |
| If the connection drops | rsync carries on where it stopped | The restore stops and starts again from the beginning |
| Passes through a browser | No | Yes |

## From a file on the server (recommended for large data)

A browser upload has to arrive within about a minute, because the proxy in front of the console cuts a request that takes longer to arrive (Traefik's `readTimeout`, 60 seconds by default). Provelox does not raise that limit: it applies to every app on the server, and a copy between two servers should not pass through a laptop anyway. So large data goes through the **import folder** on the server instead: you put the file there with `rsync` or `scp`, and the console restores from it.

1. On the new server, deploy the app (so its volume exists) and let it start once. A volume that has never been created cannot be restored into.
2. Open the app, then **Configuration → Storage** (a service of a project has the same page).
3. Choose **Restore → From a file on the server** on the volume. The dialog shows the folder's path and a command to copy, like:

   ```bash
   rsync -avP ./shop-data.tar.gz root@your-server:/var/lib/provelox/imports/
   ```

   `rsync` carries on where it stopped if the connection drops (run the same command again); `scp` does not. Use the server's real address if the console's is different.
4. Run it from the machine that has the file, then choose **Refresh** in the dialog. The file appears with its size and age.
5. Pick the file, choose what to do with what is already in the volume, then **Restore**.

The restore can take several minutes for a large file. It carries on at the server if you close the page, and the app is started again when it ends. A copy that was saved on **another server** with *Save a copy on the server* (see [Downloading an app's data](/guide/downloading-data)) can be pulled straight into this server's folder, without passing through your computer:

```bash
# run on the NEW server
rsync -avP root@old-server:/var/lib/provelox/imports/shop-data-20261102-210509.tar.gz /var/lib/provelox/imports/
```

### The import folder

- **Where.** `/var/lib/provelox/imports/` on the server (the machine Docker runs on, not inside any container). Set `IMPORTS_DIR` on the Provelox API to use another absolute path (letters, digits and `. _ - /` only). Docker creates the folder the first time it is used, and Provelox sets it to mode `0700`, owned by root. A folder you made yourself with another owner is left as it is.
- **What is listed.** Regular files whose names end in `.tar.gz` or `.tgz` (a volume archive) or in `.dump`, `.sql` or `.sql.gz` (a database dump, see [Backing up and restoring a database](/guide/database-backup)), and use only letters, digits and `. _ - ` (no spaces, no leading dot). Links, folders and hidden files are never listed. At most the 200 newest files are shown.
- **Volume archives and dumps stay apart.** A volume restore lists and accepts only `.tar.gz` and `.tgz` files: a dump in the same folder is never shown in its dialog and is refused by name if asked for. A database restore does the reverse. In a volume restore, a file that does not start like gzip is shown as "not a gzip archive" and cannot be chosen.
- **Only this folder.** The console and API never accept a path. A file is named, then looked up in what the folder really holds; a name with a slash or `..` is refused, and so is a name the folder does not hold. That is what stops "restore from the server" from becoming "read any file on the machine".
- **Deleting.** The trash button in the dialog deletes a file from the folder, after asking. It removes only a regular file by name. The folder is yours to tidy: archives hold the data, secrets included, so delete them when you are done.
- **Free space.** The dialog shows the free space on the disk the folder is on. A restore is refused when there is less free space than the archive's own size, since it grows when unpacked.
- **Who can.** Only administrators can list the folder, restore from it, or delete from it. An access token, even an `update` one, is refused. Each restore and each delete is recorded in the activity log with who did it and which file, never what was in it.

## From my computer

1. Do steps 1 and 2 above.
2. Choose **Restore → From my computer** and pick the file. Any tar archive compressed with gzip works, including the ones **Download** makes.
3. Choose what to do with what is already in the volume, then **Restore**. A progress bar shows the upload; **Cancel upload** stops it.

The dialog warns above 200 MB and does not offer an upload above 2 GB, and points to the server folder. The limit that actually decides is the time: the whole upload has to arrive in about a minute, so a 100 MB file on a slow connection can fail while a larger one on a fast connection succeeds. If the upload is cut, the app is started again and nothing more is written.

## While the data is written

The app is **stopped**, and it starts again by itself, with the number of instances it had, however the restore ends: finished, failed, or cancelled by closing the tab. A persistent app is unavailable for the length of the restore (plus the upload, if it came from the browser), so choose a quiet time for a large one.

## Into an empty volume, or replace

| | Only if the volume is empty (default) | Replace what is there |
| --- | --- | --- |
| A volume with files in it | Refused. Nothing is changed and the app is not stopped | Everything is deleted first |
| Confirmation | None | Type the app's name |
| If the restore stops half way | The volume may be partly written | The volume is empty or partly written |

**Replacing is destructive and cannot be undone.** The dialog links to **Download a copy first**; do that unless you are certain. If a replace fails or is cancelled half way, the volume is left partly written, and the answer says so: restore a copy of it again before starting the app on it for real. The same restore, run again, empties the volume and starts over.

When restoring from a server file, the file is checked (a plain file, starting like gzip) *before* the volume is emptied, so a bad or swapped file never costs you the data that is there.

## Databases

**Restoring the files of a database only works if the copy was consistent.** A copy taken while the database ran (a live download) can fail to start, or lack recent writes. Restoring the files of a database to a different major version, or to a different image, can also fail. For a database, prefer:

- a copy taken with **Stop the app while copying**, restored into the same image version; or
- a dump made with the database's own tool loaded into a new, empty database. For PostgreSQL, MySQL and MariaDB Provelox does this for you, while the app keeps running, and large dumps go through the same import folder with `rsync`: see [Backing up and restoring a database](/guide/database-backup). For MongoDB and Redis, which are not supported there yet, use `mongodump` or the database's own tool.

The console says so for images that look like a database.

## What is kept

- **Owners, groups and permissions** are kept exactly as they are in the archive, by number. A database refuses to start when its files belong to the wrong user, which is why the helper that extracts the archive is allowed to give files their owners (and nothing else beyond that).
- Links and folders come through as they were. Files already in the volume are only removed when you choose to replace.

## What you should know

- **Only administrators can restore.** An access token, even an `update` one, is refused. Each restore is recorded in the activity log with who did it and which volume (and, from the server folder, which file), never what was in it.
- **Only volumes on the machine Provelox runs on.** In a cluster, an app whose data is on another machine answers "the data is on `<machine>`": restore from that machine's own Provelox, with its own import folder.
- **Server directories are not volumes.** A folder of the server mounted into the app is refused; copy into it from the server itself.
- **The archive is treated as untrusted.** It is extracted by a short-lived container that can write only to that one volume (and read the import folder, read-only): no network, a read-only system, no privileges except giving files their owners, and a memory limit. A file that is not gzip is refused before anything is stopped or changed.
- **Disk space.** A compressed archive can be much larger once unpacked, and nothing limits it except the disk. Make sure the server has room for the unpacked data.
- **Time limits.** A restore from the server folder has none: the work happens on the server, and the page only waits for the answer. A browser upload is limited by the proxy to about a minute to arrive; the console's own server and the API use their ordinary limits (five minutes), which are not the ones that bind.
- **Hubs and instances.** An app managed by a hub cannot be restored this way (the hub would start it again). An app with several instances cannot be either.

## From the API

```bash
# from a file already in the import folder (no body): into an empty volume
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/apps/shop/volumes/data/restore?from=shop-data.tar.gz"
# replace what is there: confirm with the app's name
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/apps/shop/volumes/data/restore?from=shop-data.tar.gz&replace=1&confirm=shop"

# what the folder holds, and removing a file (the name is sent again as confirm)
curl -fS -H "Authorization: Bearer $ADMIN_TOKEN" "https://api.example.com/v1/system/imports"
curl -fS -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/system/imports/shop-data.tar.gz?confirm=shop-data.tar.gz"

# uploading the archive as the body instead (small files)
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/gzip" --data-binary @shop-data.tar.gz \
  "https://api.example.com/v1/apps/shop/volumes/data/restore"
```

`GET /v1/system/imports` answers `{"dir": "/var/lib/provelox/imports", "files": [{"name": "shop-data.tar.gz", "sizeBytes": 1234, "modifiedAt": "2026-11-02T21:05:09.000Z", "gzip": true, "kind": "volume"}], "freeBytes": 53687091200}`. `kind` is `volume` for a `.tar.gz` or `.tgz` and `database` for a `.dump`, `.sql` or `.sql.gz`; a volume restore with `from=` a database dump answers 400.

A restore answers `{"restored": true, "bytes": 1234, "replaced": false, "stopped": true}` (and `"file"` when it came from the folder). A volume that is not empty answers 409, a file that is not gzip or a bad name 400, a file the folder does not hold or a volume the app does not have 404, a body together with `from` 400, and an access token 403.
