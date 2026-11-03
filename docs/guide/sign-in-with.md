# Sign in with Google, GitHub or your company

Provelox can ask visitors to sign in before they reach an app. Only the people you list get in, the app is told who they are, and the app needs no sign-in code of its own. It works for any app, whatever it is written in, because the proxy does the check.

Use it for internal tools, staging sites and admin panels. For a shared password instead, see **Networking → Password protection**.

## What you need

- The API reachable at an address of its own (for example `https://api.example.com`), because the identity provider sends people back to it. An install made with an API address has this. Provelox reads it from `API_PUBLIC_URL`.
- An account at the identity provider to register Provelox with, once.

## Set it up

1. **Register Provelox at the provider.** Open an app, then **Networking → Sign in with…**, switch it on, pick **Add a provider…**, and choose the kind. The dialog shows the one **redirect address** to register, and where to register it:
   - **Google:** Google Cloud console → Credentials → OAuth client ID (Web application).
   - **GitHub:** Settings → Developer settings → OAuth Apps.
   - **OpenID Connect:** Okta, Microsoft Entra, Keycloak, Auth0 and others. Create a web application and use its **issuer address**, for example `https://yourcompany.okta.com`.
2. **Paste the client ID and client secret** into the dialog. The secret is stored encrypted and is never shown again.
3. **Say who may sign in**, one per line:
   - an email address (`ada@example.com`) lets that person in;
   - a domain (`@yourcompany.com`) lets in everyone with an address there. Subdomains are not included.
4. **Save.** It applies at once.

The same provider can protect any number of apps, and its redirect address is registered once.

Optionally list **paths that stay open** (a webhook, a health check). They are reachable without signing in.

## What the app receives

On every request that gets through, the proxy adds:

| Header | Value |
| --- | --- |
| `X-Provelox-Email` | the signed-in person's verified email address |
| `X-Provelox-User` | their name, or their email address when the provider gives none |

A visitor cannot forge them: any copy sent by the browser is replaced. Both are set on every request that passes the check.

An app can sign someone out by sending them to `/.pvx-auth/logout`.

## How it behaves

- A page load without a sign-in goes to the provider and back, then continues to the page that was asked for. Anything else (an API call, a form post) gets `401`.
- Someone the provider signs in but you did not list sees "Not allowed", and is never sent to the app.
- The provider must vouch for the email address. GitHub uses the primary verified one.
- A sign-in lasts 12 hours (`SSO_SESSION_HOURS`).
- The rules are checked on every request, so removing someone takes effect on their next click.
- The sign-in pages live at `/.pvx-auth/` on the app's own address. An app must not use that path.

## If something is missing, the app stays closed

If an app is set to require sign-in but Provelox cannot provide it (for example the API address is gone), the app is not served at all. It is never served open.

## Combining with other protections

With a password as well, visitors sign in first and are then asked for the password. Paths stay open only if both list them. Behind a CDN, the CDN check runs first.
