# Provelox documentation

The site is built with [VitePress](https://vitepress.dev). It is its own package: the API and its image do not depend
on it.

```bash
cd docs
npm install
npm run dev       # http://localhost:5180
npm run build     # static site in .vitepress/dist
```

## Run it as an app

Every change to `main` publishes the image as `ghcr.io/provelox/docs` (`latest`, and `sha-<commit>`; amd64 and arm64) from
`.github/workflows/docs-image.yml`, after running it and asking it for a few pages. Pull requests that change the docs
build and test it without publishing.

The `Dockerfile` here builds the site and serves it with nginx on port 80, so it runs as an ordinary app on Provelox:

```bash
docker build -t provelox-docs:local docs
```

Then create an app (container port 80) and deploy that image. If the platform leaves new apps without a default address,
turn it on for this app so it is reachable at `<app>.<root domain>`.

Pages are plain Markdown under `guide/`, `migration/` and `reference/`. The sidebar lives in `.vitepress/config.ts`.
