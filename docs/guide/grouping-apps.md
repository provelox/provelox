# Group running apps into a project

Apps you started one at a time can be moved into a compose project without being redeployed from scratch. Their data stays, their addresses keep working, and apps that can stay up while they move do.

You can group them into a **new project** or add them to a project that **already exists**.

## How to do it

Wherever an app is shown there is a way in, and all of them end in the same review step:

- **Apps list, one app:** "Move into a project…" in the row menu.
- **Apps list, several at once:** tick the apps, then "Group into a project" in the bar that appears.
- **Apps list, from a list:** New → "Group running apps" shows every app that is in no project, with a tick box each, and where to put them.
- **An app's page:** the "⋯" menu beside Restart → "Move into a project…".
- **A collection's page:** tick apps in the table and choose "Move into a project…", or use the "⋯" menu to pick from the collection's apps.
- **A project's page:** Add → "Apps that already run", then tick the apps to bring in.

Provelox writes a compose file for the chosen apps (or adds their services to the project's file). You can edit it like any other compose file, fill in the variables, and review before anything changes. Nothing moves until you confirm.

## What is kept

- **Data.** A volume keeps its Docker name, so the container that comes back after the move mounts the same data. No copy is made and no new volume is created. A later update of the project keeps using it.
- **Addresses.** Domains and ports stay. An app that was served at its default address (`<name>.<your domain>`) keeps answering there, because that address is kept as an explicit domain.
- **Settings made in Networking.** The primary domain, HTTPS, the redirect to HTTPS, password protection, sign-in, CDN settings and custom error pages are kept as they are. These are set in the app's Networking tab, never in a compose file, so the generated file cannot show them. To make that visible, the review lists what each moving app keeps ("Keeps: Addresses: portal.example.com (HTTPS, primary)…"), and the file has a comment under each service saying the same. The comment is only a comment: it changes nothing, and it survives the **Format** button.
- **The old name.** It stays as an alias on the project's private network, so other apps that connect to it by that name keep working.
- **Existing services.** When you add apps to a project that exists, its own services start from the values they run with now, so nothing is blanked.
- **Settings.** Environment variables, resources, healthcheck, command, pins, deploy keys and usage history move with the app. Values whose names look like secrets (`PASSWORD`, `SECRET`, `TOKEN`, `KEY`) become `${VARIABLES}` in the file, filled in from the running app, so they are not written into the compose file.

## What is interrupted

The review lists every app that moves and says whether it is interrupted.

| App | During the move |
| --- | --- |
| No volume and no published host port | Not interrupted. The new container starts and must be running before the old one stops. |
| Has a volume, or publishes a host port | Stopped briefly. A volume can be used by one container at a time and a host port by one service at a time, so the old container goes first. |

Apps that are not interrupted move first, in the order of the compose file; apps that have a gap move last, so the rest are already settled.

If an app that has a gap fails to start in its new place, Provelox puts the old one back as it was.

## What cannot be grouped yet

An app is refused, with the reason shown, when it:

- already belongs to a project,
- is managed by a hub,
- has not been deployed yet,
- uses Docker secrets (a project cannot hold them yet),
- mounts a directory of the server,
- is waiting for a port that another platform still holds.

Fix what the reason says and try again.

## After the move

The app is a service of the project now, so renaming the service in the compose file later is a rename of a project service: the review offers to keep what the old app had (its domains, deploy keys and history). See Reference → Compose file → Updating a project → Renaming a service.

## Good to know

- The new services are named `<project>-<service>`, like any service of a project. The app's name changes to match, and its history follows it.
- Grouping cannot be undone with one click. To take an app out, remove it from the project's compose file; its volume is kept.
- The compose file for a new project shows a new volume as `data: null`. This is the same as `data:`.

## API

- `POST /v1/projects/from-apps` with `{"apps": ["blog", "docs"]}` returns the compose file, variables and the moves that grouping would make, ready to preview and deploy as a new project.
- `POST /v1/projects/:name/add-apps` with `{"apps": [...]}` does the same against an existing project.
- The preview of a project with apps moving in returns `adopting: [{service, app, to, gap}]`, and the deploy accepts the same list back as `adopt`.
