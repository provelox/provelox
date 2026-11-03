# The documentation site: VitePress builds static files, nginx serves them.
FROM node:24 AS build
WORKDIR /docs
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /docs/.vitepress/dist /usr/share/nginx/html
EXPOSE 80
