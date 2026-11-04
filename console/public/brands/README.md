# Logos of the apps in the template catalog

These files are the logos of the open-source apps Provelox can deploy from its template catalog. They are shown next to
each template only so you can tell the apps apart. They belong to their projects and owners, whose names and marks they
are; including them does not mean those projects endorse, sponsor or are affiliated with Provelox, and they are not
covered by Provelox's Apache-2.0 license. If you own one and want it changed or removed, open an issue and it will be.

Most logos are not files here: the console draws them from [Simple Icons](https://simpleicons.org) (CC0 1.0), bundled in
`src/lib/brand-marks.ts`. The files in this folder are for apps Simple Icons does not have, each taken from the
project's own repository:

| File | Project | Taken from |
| --- | --- | --- |
| `anythingllm.png` | AnythingLLM | Mintplex-Labs/anything-llm, `frontend/src/media/logo/anything-llm-icon.png` |
| `docuseal.svg` | DocuSeal | docusealco/docuseal, `public/favicon.svg` |
| `gotify.png` | Gotify | gotify/server, `ui/public/static/favicon-128.png` |
| `healthchecks.svg` | Healthchecks | healthchecks/healthchecks, `static/img/favicon.svg` |
| `homebox.svg` | Homebox | sysadminsmedia/homebox, `frontend/public/favicon.svg` |
| `ittools.png` | IT-Tools | CorentinTh/it-tools, `public/android-chrome-192x192.png` |
| `linkding.svg` | Linkding | sissbruecker/linkding, `assets/logo.svg` |
| `linkwarden.png` | Linkwarden | linkwarden/linkwarden, `apps/web/public/icon.png` |
| `litellm.png` | LiteLLM | BerriAI/litellm, `litellm/proxy/logo_monogram.png` |
| `mailpit.svg` | Mailpit | axllent/mailpit, `server/ui/favicon.svg` |
| `memos.svg` | Memos | usememos/memos, `web/public/logo.svg` |
| `miniflux.png` | Miniflux | miniflux/v2, `internal/ui/static/bin/icon-120.png` |
| `nocodb.png` | NocoDB | nocodb/nocodb, `packages/nc-gui/assets/icon.png` |
| `openwebui.svg` | Open WebUI | open-webui/open-webui, `backend/open_webui/static/favicon.svg` |
| `pgadmin.png` | pgAdmin | pgadmin-org/pgadmin4, `web/pgadmin/static/img/logo-128.png` |
| `photoprism.svg` | PhotoPrism | photoprism/photoprism, `assets/static/icons/logo.svg` |
| `privatebin.svg` | PrivateBin | PrivateBin/PrivateBin, `img/icon.svg` |
| `shlink.svg` | Shlink | shlinkio/shlink-web-client, `public/favicon.svg` |
| `stirlingpdf.svg` | Stirling PDF | Stirling-Tools/Stirling-PDF, `app/core/src/main/resources/static/favicon.svg` |
| `valkey.svg` | Valkey | valkey-io/valkey-io.github.io, `static/img/Valkey-logo.svg` |
| `yourls.svg` | YOURLS | YOURLS/YOURLS, `images/yourls-logo.svg` |

A template names its logo with the `icon` field: either a Simple Icons name (`postgresql`) or `/brands/<file>`. A test
in the API (`catalog.spec.ts`) fails when a template names a logo that is not here.
