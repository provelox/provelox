# Template registry

`provelox-templates.yaml` is a template registry for Provelox: popular apps that need more than one service.

| Template      | Services                                         |
| ------------- | ------------------------------------------------ |
| WordPress     | WordPress, MariaDB                               |
| DocuSeal      | DocuSeal, PostgreSQL                             |
| Nextcloud     | Nextcloud, MariaDB, Redis                        |
| n8n           | n8n, PostgreSQL                                  |
| Ghost         | Ghost, MySQL                                     |
| Paperless-ngx | Paperless-ngx, PostgreSQL, Redis                 |
| Metabase      | Metabase, PostgreSQL                             |
| Directus      | Directus, PostgreSQL (PostGIS), Redis            |
| Squidex       | Squidex, MongoDB                                 |

Every password and secret key is a generated variable, so no two deployments share one. Each project's services reach
each other by name (`db`, `redis`, `broker`) on the project's private network, and only the app itself is public.

Ghost doubles as a headless CMS (it has a Content API), so it is listed under the *CMS* category with Directus and
Squidex. Strapi and Payload are left out on purpose: neither publishes an official ready-to-run image (they are built
from your own project), so a template for them would have to point at a community image that nobody maintains for you.

## Use it

Host the file anywhere a plain `GET` reaches, then in the console open **Settings → Template registries**:

- **Index file address**: paste its address, for example
  `https://raw.githubusercontent.com/provelox/provelox/main/registry/provelox-templates.yaml`.
- **Git repository**: give the repository (`https://github.com/provelox/provelox`), the branch (`main`) and the file
  (`registry/provelox-templates.yaml`). A private repository needs an access token.

To put it on every server at once, send it with `PUT /v1/templates/sources/sync`.
How the format works is in the documentation, under *Guide → Template registries*.

## Change it

Each template is a normal Compose file inside `compose: |`. A test (`api/src/templates/shipped-registry.spec.ts`) reads
this file and checks that every variable is declared and used, and that each template plans and deploys as a project with
nothing refused, so run `npm test` in `api/` after an edit.
