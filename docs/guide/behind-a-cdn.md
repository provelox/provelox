# Behind a CDN

When a CDN (CloudFront, Cloudflare, Fastly or another) sits in front of an app, every visitor reaches the server from the CDN's address. This page says what to set in Provelox, what to set at the CDN, and what the app should read to find the visitor's real address. It needs Provelox 0.5.0 or later.

## The problem it solves

Without any setup, the proxy treats the CDN as an ordinary visitor and replaces `X-Forwarded-For` with the CDN's address. An app that counts or limits visitors by IP sees everyone behind the same CDN edge as one visitor, so a limit such as "25 views a day per visitor" is shared by thousands of people.

## Set it up, in this order

1. **At the CDN: pass the visitor's address to the origin.**
   - **CloudFront** does not send `CloudFront-Viewer-Address` to the origin unless the distribution's **origin request policy** includes it. Use the managed policy `AllViewerAndCloudFrontHeaders-2022-06`, or add the header to your own policy. Without this the header never arrives.
   - **Cloudflare** sends `CF-Connecting-IP` by default.
   - **Fastly** sends `Fastly-Client-IP` by default.
2. **In Provelox: tell the app which CDN is in front.** Open the app, then **Networking → CDN**, switch it on, pick the CDN and save. Or with the API: `PATCH /v1/apps/<app>` with `{"cdn": {"provider": "cloudfront", "enforce": true}}`. Provelox then:
   - keeps the CDN's `X-Forwarded-For` instead of replacing it, and
   - with **Only allow requests from the CDN** (`enforce`), answers only requests that come from the CDN's address ranges. Anyone else gets `403 Forbidden`.
3. **In the app: read the right header** (next section).
4. **Check it** (last section). Then retire any older way of locking the origin to the CDN, such as a shared secret sent as basic auth.

Provelox knows the address ranges of CloudFront (the addresses it connects to origins from), Cloudflare and Fastly, and refreshes them every six hours (`CDN_REFRESH_HOURS`). For another CDN, choose **Another CDN…** and give it a list of ranges or an address that serves them.

## What the app should read

| CDN | Header with the visitor's address | Format |
| --- | --- | --- |
| CloudFront | `CloudFront-Viewer-Address` | `203.0.113.7:46532` (address, then port) |
| Cloudflare | `CF-Connecting-IP` | `203.0.113.7` |
| Fastly | `Fastly-Client-IP` | `203.0.113.7` |
| Other | whatever the CDN documents; set it as the CDN's header in Provelox | |

The CDN sets that header itself and overwrites any value the visitor sent, so it is the one to trust. **Trust it only when "Only allow requests from the CDN" is on.** Otherwise anyone who finds the server's address can skip the CDN and send any value.

CloudFront's header carries a port. Split on the **last** colon, because an IPv6 address contains colons too:

```ts
// CloudFront-Viewer-Address: "203.0.113.7:46532" or "2001:db8::1:46532"
export function viewerIp(headers: Headers): string | null {
  const v = headers.get('cloudfront-viewer-address');
  if (v) return v.slice(0, v.lastIndexOf(':')).replace(/^\[|\]$/g, '');
  return null;
}
```

### If the app has to use `X-Forwarded-For`

With a trusted CDN, `X-Forwarded-For` reads `<what the visitor claimed>, <visitor as the CDN saw it>, <the CDN's edge, added by Provelox>`. The **first** entry is whatever the visitor sent, so it can be forged. Do not use it for limits or access control. If you must use this header, take the entry just before the last one: the last is the CDN's own address, and the one before it is the address the CDN saw the visitor connect from.

### Counting visitors

An IPv6 visitor can switch addresses freely within their `/64`, so a per-address limit is easy to dodge. Count IPv6 visitors by their `/64` prefix and IPv4 visitors by the full address.

## Check it

- **The header arrives.** Deploy a page that prints the request headers (the `traefik/whoami` image does) and open it through the CDN. Look for the header from the table above. If it is missing on CloudFront, the origin request policy is the cause.
- **The origin is locked.** Request the server's own address directly (`curl -H 'Host: app.example.com' http://<server-ip>/`). With enforcement on, it must answer `403`. Through the CDN it must answer normally.
- **Two visitors, two addresses.** Open the app from two networks (for instance a phone on mobile data) and compare what the app logs.

## Good to know

- A change in the ranges Provelox trusts restarts its proxy for a second or two, and the app may answer one `404` while the proxy finds its routes again. This happens only when a CDN's ranges change, which is rare.
- A refresh that fails, comes back empty or shrinks to under half keeps the ranges already saved and shows a warning on the CDN card. The state is also in `GET /v1/cdn`.
- CloudFront's origin-facing ranges are shared by every CloudFront customer, so another person's distribution could also reach an origin that only checks the ranges. If that matters, keep a secret header (set in the distribution's origin settings) and have the app check it too.
- `PROXY_TRUSTED_IPS` (comma-separated ranges) trusts extra proxies by hand, for a setup Provelox does not model.
