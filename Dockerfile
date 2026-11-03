# syntax=docker/dockerfile:1
#
# One image for the whole platform. Roles are picked by command: `api` (default), `console`, `install`, `bootstrap`.
#   docker build -t provelox:dev .

# API build: the full Node image has the toolchain better-sqlite3 needs to compile
FROM node:24 AS api-build
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY api/tsconfig.json api/tsconfig.build.json api/nest-cli.json ./
COPY api/src ./src
RUN npx nest build && npm prune --omit=dev --no-audit --no-fund

# Console build (Next.js standalone). Only what the build needs is copied, so local files such as node_modules or
# .env never end up in the image.
FROM node:24 AS console-build
WORKDIR /console
ENV NEXT_TELEMETRY_DISABLED=1
COPY console/package.json console/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY console/next.config.ts console/tsconfig.json console/postcss.config.mjs console/components.json ./
COPY console/src ./src
COPY console/public ./public
RUN npm run build

# Everything the running image holds, put together once so it can be trimmed once: the files nothing reads at run time
# come out (see scripts/image/trim.mjs). The runtime stage then takes the result in a single layer.
FROM node:24-slim AS assemble
WORKDIR /app
COPY api/package.json ./
COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/dist ./dist
COPY --from=console-build /console/.next/standalone ./console
COPY --from=console-build /console/.next/static ./console/.next/static
COPY --from=console-build /console/public ./console/public
COPY scripts/image/trim.mjs /tmp/trim.mjs
RUN node /tmp/trim.mjs /app

# Runtime
FROM node:24-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY --from=assemble /app /app
# The API runs as root on purpose: it needs the Docker socket, which is root-equivalent anyway, and owns /data.
# The console service is started as the unprivileged "node" user.
# The release this image is, so the API and console can say it. Set by the release workflow from the tag (0.2.5,
# or "edge" for main); a local build says "dev".
ARG PROVELOX_VERSION=dev
ENV PROVELOX_VERSION=$PROVELOX_VERSION
VOLUME /data
EXPOSE 4000 3000
ENTRYPOINT ["node", "/app/dist/entry.js"]
CMD ["api"]
