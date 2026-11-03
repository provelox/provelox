# Downloading an app's data

An app that keeps data on a Docker volume (a database, uploads, anything under **Configuration → Storage**) can be saved as one `.tar.gz` file: to your own computer, or into a folder on the server for moving with `rsync`. Use it for a backup before a risky change, to move data to another server, or to get it off a machine you no longer trust. To put such a file back into a volume, see [Restoring an app's data](/guide/restoring-data); for moving everything to another server, see [Moving to a new server](/guide/moving-to-a-new-server).

## How to do it

1. Open the app, then **Configuration → Storage**. (A service of a project has the same page.)
2. Choose **Download** on the volume.
3. Choose where the copy goes, and how to copy (see below), then **Download** or **Save a copy**.

Either way the file is named with the app's name, the volume's name and the time: `shop-data-20261102-210509.tar.gz`. Unpack it with `tar -xzf shop-data-20261102-210509.tar.gz -C some-folder`. File owners and permissions are stored in the archive; extract as root to keep them.

## To this computer, or saved on the server

| | To this computer | Save a copy on the server |
| --- | --- | --- |
| Where the file goes | Your browser, in a new tab that closes by itself | The import folder on the server (`/var/lib/provelox/imports/`) |
| Size | Fine for small volumes. The file is streamed, but a long download can be cut by a flaky connection | No limit but the disk |
| Then | Keep it, or upload it to another server | Fetch it with `rsync` or `scp`, or restore it on another server |
| If the page is closed | The download stops (and a stopped app is started again) | The copy carries on at the server, and a stopped app is started again when it ends |

**Save a copy on the server** writes the archive into the import folder as a hidden file and moves it into place only when it is complete and has been read back to the end, so a half-written or cut-short file is never listed or restored: a copy that fails (a full disk, say) leaves nothing behind and says why. The dialog then shows the file's path and a command to fetch it, like:

```bash
rsync -avP root@your-server:/var/lib/provelox/imports/shop-data-20261102-210509.tar.gz ./
```

To move data to another Provelox server, put the file in **that** server's import folder (run the `rsync` there, pulling from the old server) and choose **Restore → From a file on the server**. See [Restoring an app's data](/guide/restoring-data#from-a-file-on-the-server-recommended-for-large-data) for the folder, and [Moving to a new server](/guide/moving-to-a-new-server) for the whole runbook. The folder is listed, and files in it can be deleted, from the restore dialog.

## Live copy or stop the app first

| | Live copy | Stop the app first |
| --- | --- | --- |
| The app | Keeps running | Stopped until the file has been sent (or saved), then started again by itself |
| The data | May be out of step: a file written during the copy can be half old and half new | Consistent |
| Files that change or vanish while read | Left out, and the copy still completes (a saved copy says so) | Not possible |

**A live copy of a running database may not be consistent.** Files of a running PostgreSQL, MySQL, MongoDB or Redis are being written all the time, so the copy can fail to start, or lack recent writes. For a database, prefer **Stop the app while copying**, or take a dump with the database's own tool. For PostgreSQL, MySQL and MariaDB Provelox takes the dump for you while the app keeps running, as a download or saved into the same import folder: see [Backing up and restoring a database](/guide/database-backup). For MongoDB and Redis, which are not supported there yet, use `mongodump` or the database's own tool. The console says so for images that look like a database, and starts from "stop" for them.

If you stop the app, it comes back with the same number of instances however the copy ends: finished, cancelled by closing the tab, or failed. A persistent app is down for the length of the copy, so choose a quiet time for a large one. An app managed by a hub cannot be stopped this way (the hub would start it again); copy it live or stop it from the hub. An app with several instances cannot be stopped this way either.

## What you should know

- **The archive holds everything on the volume, passwords and keys included.** Treat the file like the data itself: keep it somewhere private and delete it when you are done. A file in the import folder is readable only by root on the server (the folder is mode `0700`), and can be deleted from the restore dialog.
- **Only administrators can download or save a copy.** An access token, even an `update` one, is refused. Each one is recorded in the activity log with who took it and which volume (and, for a saved copy, the file name), never what was in it.
- **Only volumes on the machine Provelox runs on.** In a cluster, an app whose data is on another machine answers "the data is on `<machine>`": copy it from that machine's own Provelox.
- **Server directories are not volumes.** A folder of the server mounted into the app (a bind mount) is refused with its path; copy it from the server itself.
- **Large volumes.** The file is streamed while it is made, so nothing is held in memory. A download needs no space on the server; a saved copy needs room in the import folder's disk for the compressed archive (if there is not enough, the copy fails and is removed).
- **Nothing is changed on the server** apart from the new file. The volume is read through a short-lived container with the volume read-only, no network and a memory limit; for a saved copy that container can also write the import folder, and nothing else.

## From the API

```bash
curl -fL -H "Authorization: Bearer $ADMIN_TOKEN" \
  -OJ "https://api.example.com/v1/apps/shop/volumes/data/download"
# consistent copy: stops the app while it is copied, then starts it again
curl -fL -H "Authorization: Bearer $ADMIN_TOKEN" \
  -OJ "https://api.example.com/v1/apps/shop/volumes/data/download?stop=1"

# save a copy in the import folder on the server instead (add ?stop=1 for a consistent one)
curl -fS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://api.example.com/v1/apps/shop/volumes/data/export"
```

`data` is the volume's name as shown on the Storage page. A volume the app does not have, or one of another app, answers 404. A saved copy answers `{"file": "shop-data-20261102-210509.tar.gz", "sizeBytes": 1234, "dir": "/var/lib/provelox/imports", "stopped": false, "note": ""}`; `note` says when files changed while they were read and were left out. A full disk answers 503 and keeps nothing.
