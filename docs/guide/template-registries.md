# Template registries

Templates are ready-made apps you deploy from the **Templates** page: a database, a CMS, a tool, with the few values it
needs asked for in a form. Provelox ships a few. A **template registry** lets you offer your own next to them, for your
team or for everyone: it is one file that lists templates, hosted anywhere you can serve a file from.

A template is a Docker Compose file plus a short description of it. Deploying one is the same as pasting that Compose
file as a project, with the same checks, so a registry can offer anything a person could paste, and nothing more.

## The shortest way to start

1. Make a file called `provelox-templates.json` with this in it:

   ```json
   {
     "name": "Acme templates",
     "templates": [
       {
         "id": "acme-docs",
         "name": "Acme Docs",
         "description": "Our internal documentation site.",
         "category": "Web",
         "icon": "nginx",
         "mainService": "docs",
         "publicWeb": true,
         "compose": "services:\n  docs:\n    image: nginx:alpine\n    restart: unless-stopped\n    x-provelox:\n      expose: true\n      port: 80\n"
       }
     ]
   }
   ```

2. Put it somewhere that answers to a plain `GET`: a GitHub repository, an object storage bucket, a web server.
3. In the console, open **Settings → Template registries**, choose **Index file address**, paste the file's
   address and press **Add registry**.

Provelox reads the file before it saves anything. If it cannot be read, or lists nothing it can use, you are told why
and nothing is added. Its templates then appear on the Templates page, marked _From Acme templates_.

A fuller example, with a template that has a secret variable and a volume, is [provelox-templates.json](/examples/provelox-templates.json).

## The index file

JSON or YAML, whichever you prefer. At the top:

| Field       | What it is                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| `name`      | What the registry is called in the console. Optional; the address is used. |
| `templates` | The list of templates. At most 200. (A bare list also works.)              |

The file can be up to 5 MB.

### A template

| Field         | Required | What it is                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Lowercase letters, numbers and dashes, up to 48. Unique within the file. It becomes the suggested project name.                                                                                                                                                                                                                                                                 |
| `name`        | yes      | What the card says.                                                                                                                                                                                                                                                                                                                                                             |
| `description` | no       | One or two sentences. The card shows two lines.                                                                                                                                                                                                                                                                                                                                 |
| `category`    | no       | A word such as `Database`, `Web`, `Tools`. Up to 30 characters; templates with the same one are listed together.                                                                                                                                                                                                                                                                |
| `icon`        | no       | A logo for the card: the name of one built in (`postgresql`, `redis`, `mysql`, `mongodb`, `mariadb`, `wordpress`, `nginx`, `grafana`, `minio`, `adminer`, `uptimekuma`, `rustfs`, `docker`, `github`, `gitlab`) **or the `https://` address of a public image** (SVG or PNG, shown square). Without one, or if the image does not load, the card shows the template's initials. |
| `mainService` | yes      | The service other apps connect to (a key under `services:` in the Compose file).                                                                                                                                                                                                                                                                                                |
| `port`        | no       | The port of that service, used to tell people how to connect.                                                                                                                                                                                                                                                                                                                   |
| `connect`     | no       | How another app connects, as a pattern: `{host}` and `{port}` are filled in, and `{VAR}` is the value chosen for that variable.                                                                                                                                                                                                                                                 |
| `publicWeb`   | no       | `true` when the template is a web page people open. The card says so.                                                                                                                                                                                                                                                                                                           |
| `variables`   | no       | The values to ask for (below).                                                                                                                                                                                                                                                                                                                                                  |
| `compose`     | one of   | The Compose file, as text.                                                                                                                                                                                                                                                                                                                                                      |
| `composeFile` | these    | Or the Compose file kept next to the index: a path (`docs/compose.yml`) or an address, read when the registry is read.                                                                                                                                                                                                                                                          |

A template with a problem (a bad `id`, no Compose file, a Compose file that cannot be fetched) is **skipped** and the
rest still load. The registry's entry in the console says how many were skipped and why.

### Variables

Anything that differs between two people deploying the template (a password, a database name, a domain) is a
variable. Write it in the Compose file as `${NAME}` and describe it in `variables`:

```json
"variables": [
  { "key": "DB_NAME", "label": "Database name", "default": "app" },
  { "key": "DB_PASSWORD", "label": "Password", "kind": "secret" }
]
```

| Field         | What it is                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `key`         | The name used in the Compose file, like `DB_PASSWORD`.                                                                 |
| `label`       | What the form calls it.                                                                                                |
| `description` | A hint under the field.                                                                                                |
| `default`     | What the field starts with.                                                                                            |
| `kind`        | `text` (the default) or `secret`. A secret is hidden in the form and **generated** for the person, who can replace it. |
| `minLength`   | The fewest characters the app accepts. A generated secret is at least this long, and a shorter value is refused in the form. |

Everything else Compose does with variables works too, in the Compose file:

| Write               | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `${NAME}`           | The value the person chose.                                     |
| `${NAME:-fallback}` | `fallback` when the field is left empty.                        |
| `${NAME:?message}`  | The field is required; deploying says `message` if it is empty. |
| `$$`                | A literal dollar sign.                                          |

A variable used in the Compose file but missing from `variables` still gets a field (named by its key), so list every
one to give it a good label, a hint, a default or the `secret` kind.

A Compose file can also carry its own declarations, so it works the same pasted into **New → Compose project** as inside a
template. Put them at the top level, under `x-provelox` (plain Docker Compose ignores it):

```yaml
x-provelox:
  variables:
    JWT_SECRET: { secret: true, minLength: 32, label: Sign-in secret }
    PII_ENCRYPTION_KEY:
      secret: true
      minLength: 32
      description: Back it up. Losing it makes stored data unreadable.
```

| Field         | What it is                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- |
| `secret`      | `true` hides the field and generates a value (`kind: secret` means the same).                 |
| `minLength`   | The fewest characters, 1 to 256. A generated value is at least this long; shorter is refused. |
| `label`       | What the form calls it.                                                                       |
| `description` | A hint under the field.                                                                       |

The check runs in the form and again in the preview and the deploy, so a value that is too short never reaches a service.
A file that declares nothing still works: a name like `PASSWORD` or `TOKEN` is treated as a secret, and "at least 32
characters" or "openssl rand -hex 32" in a `${NAME:?message}` is read as a minimum length. Declare it instead of relying on that.

Values are put into the services when the project is deployed and are not kept anywhere else. The project page shows
them again by reading them back from the running services, which is how the _Connection_ card can say how to connect.

## The Compose file

It follows the same rules as any project's, so test it by pasting it into **New → Compose project** first. The ones
that matter most when writing a template:

- Use `image:`. Images are not built here: push yours to a registry first.
- A service is reachable only by the project's other services unless it carries
  `x-provelox: { expose: true, port: 80 }`, which gives it a web address.
- Named `volumes:` keep data. Their data survives redeploys, and is kept (unless the person asks) when the project is
  removed.
- Refused, because they would give a service more power over the server than an app has: `privileged`, `cap_add`,
  `devices`, `network_mode`, `pid`, `ipc`, `security_opt`, `sysctls`, `build`, `env_file`.
- `depends_on` sets the start order.

### Logos from a public address

`"icon": "https://example.com/acme.svg"` shows that image on the card. It is loaded by the person's **browser**, not by
Provelox, so it has to be public (no login), served over `https`, and ideally a square SVG or PNG. Keep in mind that this
tells whoever hosts the image that someone opened the Templates page.

## Keeping the registry in a git repository

Instead of an address, choose **Git repository**. Give it the repository's address (GitHub, GitLab, Bitbucket, Gitea or
Forgejo), the branch or tag (default `main`) and the path of the index file in it (default `provelox-templates.json`).
Provelox reads that one file over HTTPS, the same way a browser would show its raw contents. It does not clone the
repository, so the Compose files must either be inline or named by `composeFile` relative to the index.

A repository of templates can look like this:

```
provelox-templates.json
docs/compose.yml
shop/compose.yml
```

with `"composeFile": "docs/compose.yml"` in the index.

## Private registries

If the file is behind a login (a private repository, a protected bucket), add an **access token**. It is sent as an
`Authorization: Bearer` header (and `PRIVATE-TOKEN` for GitLab) **only to the address you gave**, never to a place it
redirects to, and is stored encrypted and never shown again. A GitHub personal access token with read access to the
repository's contents works for GitHub repositories.

## On many servers

If you run several Provelox servers, keep the same registries on all of them through the API, with a
token that has the *update* scope: `PUT /v1/templates/sources/sync` with `{ "kind": "index", "url": "…", "token": "…" }`
adds the registry, or updates it when its address is already there.

## Keeping it up to date

Provelox keeps what it last read. It reads the registry again when you press the refresh button next to it, and in the
background when what it has is older than six hours. If a refresh fails (the file is down, someone broke the JSON), the
registry keeps showing the last good templates and says what went wrong.

## Safety

Provelox only reads the file: it never runs anything from it, and it refuses addresses that point at cloud metadata or
link-local services. But a template **names images and settings that run on your server**. Add only registries you
trust, and read a template's Compose file (the deploy dialog shows it) before you deploy it, as you would any other.

## Trying it before you publish it

Serve the folder from your own machine and add the address:

```bash
cd my-templates && python3 -m http.server 4799
# then add  http://<your-machine>:4799/provelox-templates.json
```

If something is wrong, adding the registry says so. A template that deploys badly is almost always a Compose file
problem, so paste it into a project to see the plan and any refusals before it is a template.
