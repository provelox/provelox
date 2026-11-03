# Domains and HTTPS

Every app answers on its default address (`<name>.<apps domain>`). You can add your own domains next to it, and give each one a certificate from Let's Encrypt.

## Adding a domain

Open the app, then **Networking → Domains & HTTPS → Add domain**. The wizard asks for the domain, shows what to create at your DNS provider, and then offers to turn on HTTPS.

### The DNS record

- **A subdomain** (`api.example.com`): a `CNAME` record named `api` pointing at the app's default address. It follows the server if its address changes. The wizard also lists address records as an alternative.
- **A root domain** (`example.com`): an `A` record (and an `AAAA` record if the server has an IPv6 address) pointing at the server. A root domain cannot be a CNAME.

Each name and value has a copy button. The page checks DNS for you and looks again every few seconds until it is right, saying whether the domain does not resolve yet, resolves somewhere else (and where), or points here. DNS changes can take a few minutes, sometimes hours. If a domain is attached with HTTPS off, **Turn on HTTPS** appears as soon as DNS is right.

Behind a proxy such as Cloudflare the domain resolves to the proxy's addresses and not to this server. The check reports that as "somewhere else"; that can be fine, and trying the certificate will tell.

## When a certificate does not issue

HTTPS needs a Let's Encrypt email under **Settings → General → Domain & HTTPS**. Once HTTPS is on for a domain, the domains list shows what is happening with its certificate: waiting, issued, or the reason there is none, in plain words:

| What you see | What it means |
|---|---|
| No Let's Encrypt email | Set one under Settings. |
| DNS is not set up yet / points somewhere else | Fix the record; the page keeps checking. |
| Let's Encrypt refused | The proxy's own error is shown, explained: it could not find the name in DNS, could not connect to port 80, was answered by something other than this proxy, was stopped by a CAA record, or hit its rate limit. The text it logged is under **What Let's Encrypt said**. |
| Still no certificate | DNS is right but there is none after a few minutes. Usually port 80 is closed to the internet (a firewall or cloud security group), something else answers on port 80, or Let's Encrypt's limit for failed attempts on this name was reached. |

The reason Let's Encrypt gave is shown only when the proxy's log has one for that address; otherwise the page names the likely causes and says it is guessing.

### Retry certificate

**Retry certificate** asks the proxy to try again, after you have fixed the cause. It does this by touching a setting of the app's routing that the proxy reads (a response flush interval one to twenty milliseconds from its default), which makes the proxy look at the address again within about 15 seconds. Nothing restarts, and visitors see no difference. Applying the app again puts the setting back.

Let's Encrypt blocks a name for an hour after a few failed attempts, so retries are limited to one a minute and three an hour for each address; the button counts down. **Check DNS again** looks at DNS now without asking Let's Encrypt for anything.

Only a signed-in admin can retry, like every change to an app's domains. Access tokens can read the reason but not retry.

## Behind a CDN

If a CDN such as CloudFront or Cloudflare sits in front of an app, see [Behind a CDN](/guide/behind-a-cdn): it keeps your visitors' real addresses and can lock the app to the CDN.

## For scripts

```
GET  /v1/apps/<app>/domains/<host>/diagnosis
POST /v1/apps/<app>/domains/<host>/retry-certificate
```

The first answers with `verdict` (`issued`, `warning`, `off`, `waiting` or `failed`), `reason`, a `message`, the DNS result, Let's Encrypt's own error when logged, and `retryAfterSeconds`. It needs a token of at least the `read` scope. The second answers `202`, or `429` with the wait when called too soon.
