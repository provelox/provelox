# Provelox console

The web UI for the Provelox platform (`api/` in this repository): sign in, organise apps in groups, create apps with a guided
wizard, edit settings, environment variables, secrets, domains and HTTPS, deploy images with live progress, read live
logs, manage registries and CI deploy keys, move data into named volumes, and clean up disk. A ⌘K palette jumps
anywhere.

Stack: Next 16 + React 19, Tailwind 4 with shadcn-style primitives, TanStack Query, zod, sonner, vitest.

## How it talks to the API

The browser never sees the API token.

- Sign-in calls `POST /v1/auth/login` on the Provelox API from the Next.js server, then stores the token in an
  **AES-256-GCM encrypted, httpOnly, SameSite=Lax** cookie (lifetime `SESSION_HOURS`, default 8h).
- Pages are real URLs, gated by a server-side session check. A refresh keeps you signed in, and an expired or
  signed-out token (for example after a password change elsewhere) clears the cookie and sends you to `/login`.
- Every change is a Server Action calling the API. The browser only reads two things itself, both read-only and
  checked against the session: `/api/deployment/<app>` (deploy progress) and `/api/logs/<app>` (live logs, relayed
  from the API's event stream).
- CI deploy keys, groups and everything else live in the API, not here.

## Run locally

```bash
nvm use            # Node 24
cp .env.example .env.local
# set SESSION_SECRET (openssl rand -base64 48) and PROVELOX_API_URL
npm install
npm run dev        # http://localhost:4300
npm test && npm run typecheck
```

## Test

```bash
npm test                # unit tests (Vitest)
npm run typecheck
E2E_PASSWORD=<admin password> npm run e2e    # end-to-end tests (Playwright)
```

The end-to-end tests drive the real console against a real Provelox API: they sign in, change the theme, walk the
settings, and create, inspect and delete a throwaway app named `e2e-*`. Anything they create is removed afterwards, even
after a failure, and nothing else is touched. They start the dev console themselves (or reuse one on :4300) and use the
Chrome installed on the machine. Useful variables:

| Variable       | Meaning                                                                            | Default                         |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| `E2E_PASSWORD` | The admin password of the instance under test (required)                           |                                 |
| `E2E_BASE_URL` | A console that is already running, instead of starting one                         | starts `npm run dev` on :4300   |
| `E2E_API_URL`  | The Provelox API, used only to clean up `e2e-*` apps                               | `http://api.provelox.localhost` |
| `E2E_CHANNEL`  | `bundled` uses Playwright's own Chromium (`npx playwright install chromium` first) | the installed Chrome            |

`PROVELOX_API_URL` is where the Next.js server reaches the API. `PROVELOX_PUBLIC_API_URL` (optional) is the address CI
uses, shown in the workflow snippet on the API keys page; it defaults to `PROVELOX_API_URL`.

## Deploy

The console ships inside the platform image (the repository's root `Dockerfile` builds it together with the API), where the
platform starts it with the right settings. To run it on its own, `npm run build` produces a standalone server (`node
.next/standalone/server.js`): set `PROVELOX_API_URL` and `SESSION_SECRET` and serve it over HTTPS (the session cookie is
`Secure` in production).
