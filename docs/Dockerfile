# The documentation site: VitePress builds static files, nginx serves them.
# The build stage runs on the builder's own CPU (the files it makes are the same everywhere), so the image can be
# published for amd64 and arm64 without emulating anything: only the last stage, which copies files, differs.
FROM --platform=$BUILDPLATFORM node:24 AS build
WORKDIR /docs
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /docs/.vitepress/dist /usr/share/nginx/html
EXPOSE 80
