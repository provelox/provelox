# Migration overview

::: warning Work in progress
CapRover is the only supported source today. The structure is built for more: see
[Adding a source](./adding-a-source).
:::

Provelox can take over from another platform **on the same server**, with a few minutes of planned downtime for apps
that keep data.

## Principles

- **The old platform is never modified** until you reach the stages that stop it. Everything before is read-only toward it.
- **Nothing is cut over until you have seen it working on Provelox.**
- **Data is copied, never moved.** The original volume is mounted read-only; every copy is verified.
- **A failed app stays where it is.** If a cutover step fails, the apps it stopped are started again.

## The guided run

```bash
docker run --rm -it -v "$PWD":/work -w /work -v /var/run/docker.sock:/var/run/docker.sock -v /captain:/captain:ro \
  -e PVX_ADMIN_PASSWORD <provelox image> migrate --from caprover \
  --root-domain example.com --api-url http://api.example.com:8080
```

It stops for your confirmation at every stage and saves its progress, so running it again carries on where it stopped.

`-v "$PWD":/work -w /work` is not optional: progress (`provelox-migration.json`) and the saved settings of everything the cutover stops (`cutover-backup/`, what you would use to put the old platform back) are written to the current directory. Without it they are lost when the container exits, and the wizard refuses to start.

| Stage        | What happens                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Inventory | Reads the old platform's configuration and classifies every app: ready, has data, or needs attention.                                                                                              |
| 2. Import    | Previews, then creates each app on Provelox and copies its data from a read-only mount. Apps with data or host ports are created stopped.                                                          |
| 3. Test      | Checks what was created, optionally starts the apps without host ports, and lists their addresses for you to try.                                                                                  |
| 4. Cutover   | You type `cutover`. Apps with data or host ports stop on both sides, their data is copied again and verified, and they start on Provelox. The old proxy stops and Provelox takes ports 80 and 443. |
| 5. Verify    | Checks that each app runs, publishes its ports and answers. You confirm that it works.                                                                                                             |
| 6. Retire    | Stops what is left of the old platform. It can be started again.                                                                                                                                   |
| 7. Remove    | You type `remove <platform>`. Removes the old platform's services, never its data. Do it after a soak period.                                                                                      |

## Host ports

Docker Swarm refuses a second service on a published port, even one with no running instances. So an imported app that
publishes host ports (a DNS server on port 53, say) records them as **pending**, shown in the console as "Waiting for
cutover", and publishes them during the cutover.

## Rollback

| When                 | How                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before the cutover   | Do nothing. The old platform never stopped.                                                                                                                                                      |
| A cutover step fails | Automatic: the old apps this run stopped are started again, and the run stops.                                                                                                                   |
| After the cutover    | Put the stopped services back from the saved specs (`--backup-dir`, default `./cutover-backup`) and stop Provelox's proxy. Writes made on Provelox since the final copy are not in the old data. |

## Running the stages separately

`inventory`, `import` and `cutover` also run on their own. Each previews by default and needs `--apply` to change
anything. See the [command line reference](/reference/cli).
